//! SPEC 4.1: field values are JSON literals plus unquoted bare words, or a
//! `{ ... }` expression when the braces do not parse as JSON (SPEC 9).
//! Printing mirrors JavaScript's `JSON.stringify` (the reference
//! implementation serializes with it).

use crate::diag::{err, ParseError};
use crate::types::{Expr, FieldValue, Literal};
use indexmap::IndexMap;

/// SPEC 4.1: `key: value` line parsing.
pub fn parse_field(value: &str, line: u32) -> Result<FieldValue, ParseError> {
    let s = value.trim();
    if s.is_empty() {
        return Ok(FieldValue::Lit(Literal::Str(String::new())));
    }
    let c = s.as_bytes()[0];
    if c == b'"' || c == b'[' || c == b'{' {
        return match serde_json::from_str::<serde_json::Value>(s) {
            Ok(v) => Ok(FieldValue::Lit(json_to_literal(&v))),
            Err(_) => {
                if c == b'"' {
                    Err(err("E_UNTERMINATED_STRING", "unterminated string literal", line))
                } else if c == b'{' {
                    // Expression: strip the outer braces so printing
                    // `{raw}` round-trips (SPEC 9).
                    let raw = if s.ends_with('}') { &s[1..s.len() - 1] } else { &s[1..] };
                    Ok(FieldValue::Expr(Expr::new(raw.trim())))
                } else {
                    Err(err("E_BAD_LITERAL", "malformed array literal", line))
                }
            }
        };
    }
    if s == "true" {
        return Ok(FieldValue::Lit(Literal::Bool(true)));
    }
    if s == "false" {
        return Ok(FieldValue::Lit(Literal::Bool(false)));
    }
    if s == "null" {
        return Ok(FieldValue::Lit(Literal::Null));
    }
    if is_numeric(s) {
        let n = s.parse::<f64>().unwrap_or(f64::NAN);
        // Non-finite numbers cannot round-trip (they serialize as null): refuse, as TS does.
        if !n.is_finite() {
            return Err(err("E_BAD_LITERAL", &format!("number out of range: {}", s), line));
        }
        return Ok(FieldValue::Lit(Literal::Num(n)));
    }
    Ok(FieldValue::Lit(Literal::Str(unescape_bare(s))))
}

/// `^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$`
fn is_numeric(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let digits_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - digits_start;
    let mut frac_digits = 0;
    let mut has_dot = false;
    if i < b.len() && b[i] == b'.' {
        has_dot = true;
        i += 1;
        let fs = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - fs;
    }
    // TS requires at least one digit after a `.`: `1.` and `5.e3` are strings.
    if has_dot && frac_digits == 0 {
        return false;
    }
    if int_digits == 0 && frac_digits == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let es = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == es {
            return false;
        }
    }
    i == b.len()
}

/// Bare values: `\n` is a newline, `\\` a backslash, `\x` is `x`.
fn unescape_bare(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// A string may be emitted bare when `parse_field` would read it back
/// identically (SPEC 4.1).
fn bare_safe(s: &str) -> bool {
    !s.is_empty()
        && s.trim() == s
        && !s.chars().any(char::is_whitespace)
        && !s.contains(['\\', '"', '\n'])
        && !is_numeric(s)
        && s != "true"
        && s != "false"
        && s != "null"
        && !s.starts_with(['"', '[', '{'])
        && !matches_shaped_key_line(s)
}

/// `^[a-z][a-z0-9-]*:[ \t]` — shaped like a `key: value` line.
fn matches_shaped_key_line(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || !(bytes[0].is_ascii_lowercase()) {
        return false;
    }
    let mut i = 1;
    while i < bytes.len() && (bytes[i].is_ascii_lowercase() || bytes[i].is_ascii_digit() || bytes[i] == b'-') {
        i += 1;
    }
    i < bytes.len() && bytes[i] == b':' && i + 1 < bytes.len() && (bytes[i + 1] == b' ' || bytes[i + 1] == b'\t')
}

/// Print a field value: expressions as `{raw}`, safe strings bare, everything
/// else as JavaScript-style JSON.
pub fn print_literal(v: &FieldValue) -> String {
    match v {
        FieldValue::Expr(e) => format!("{{{}}}", e.raw),
        FieldValue::Lit(Literal::Str(s)) if bare_safe(s) => s.clone(),
        FieldValue::Lit(lit) => js_stringify(lit),
    }
}

/// JavaScript `JSON.stringify(v)` for a literal (compact).
pub fn js_stringify(v: &Literal) -> String {
    match v {
        Literal::Null => "null".into(),
        Literal::Bool(true) => "true".into(),
        Literal::Bool(false) => "false".into(),
        Literal::Num(n) => js_num_to_string(*n),
        Literal::Str(s) => js_quote(s),
        Literal::Arr(items) => {
            let inner: Vec<String> = items.iter().map(js_stringify).collect();
            format!("[{}]", inner.join(","))
        }
        Literal::Obj(entries) => {
            let inner: Vec<String> = entries
                .iter()
                .map(|(k, v)| format!("{}:{}", js_quote(k), js_stringify(v)))
                .collect();
            format!("{{{}}}", inner.join(","))
        }
    }
}

/// Compact JSON of a field map (used by the `x-ad-data` script tag).
pub fn js_stringify_fields(fields: &IndexMap<String, FieldValue>) -> String {
    let inner: Vec<String> = fields
        .iter()
        .map(|(k, v)| {
            let value = match v {
                // JSON.stringify sees Expr as a plain object (SPEC 9).
                FieldValue::Expr(e) => format!("{{\"kind\":\"expr\",\"raw\":{}}}", js_quote(&e.raw)),
                FieldValue::Lit(lit) => js_stringify(lit),
            };
            format!("{}:{}", js_quote(k), value)
        })
        .collect();
    format!("{{{}}}", inner.join(","))
}

/// JavaScript `Number::toString` / `JSON.stringify` number formatting:
/// plain fixed notation for 1e-6 <= |v| < 1e21, exponent notation outside it.
pub fn js_num_to_string(v: f64) -> String {
    if !v.is_finite() {
        return "null".into(); // JS JSON.stringify(NaN/Infinity) is null
    }
    if v == 0.0 {
        return "0".into();
    }
    let a = v.abs();
    if a >= 1e21 || a < 1e-6 {
        // Rust's `{}` already prints the shortest round-trip mantissa in
        // scientific form (1e21, 1.5e-7); JS wants a `+` on positive exponents.
        let s = format!("{}", v);
        return match s.split_once('e') {
            Some((m, e)) if !e.starts_with('-') && !e.starts_with('+') => format!("{}e+{}", m, e),
            _ => s,
        };
    }
    if v == v.trunc() && a < 1e21 {
        return format!("{}", v as i64);
    }
    format!("{}", v)
}

fn js_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn json_to_literal(v: &serde_json::Value) -> Literal {
    match v {
        serde_json::Value::Null => Literal::Null,
        serde_json::Value::Bool(b) => Literal::Bool(*b),
        serde_json::Value::Number(n) => Literal::Num(n.as_f64().unwrap_or(f64::NAN)),
        serde_json::Value::String(s) => Literal::Str(s.clone()),
        serde_json::Value::Array(items) => Literal::Arr(items.iter().map(json_to_literal).collect()),
        serde_json::Value::Object(entries) => {
            Literal::Obj(entries.iter().map(|(k, v)| (k.clone(), json_to_literal(v))).collect())
        }
    }
}

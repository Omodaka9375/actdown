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
            Ok(v) => {
                // Nested non-finite numbers: serde_json accepts out-of-range
                // floats (1e999 -> inf), which cannot round-trip (they would
                // serialize as null). Reject them (TS parity, SPEC 4.1).
                if has_non_finite(&v) {
                    Err(err("E_BAD_LITERAL", "number out of range", line))
                } else {
                    Ok(FieldValue::Lit(json_to_literal(&v)))
                }
            }
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
        // JS \s includes U+FEFF (and other Unicode spaces); char::is_whitespace
        // does not cover all of them, so test with an explicit Unicode space
        // scan to keep the bare form byte-identical with the TS printer.
        && !s.chars().any(|c| c.is_whitespace() || c == '\u{feff}' || c == '\u{00a0}' || c == '\u{2028}' || c == '\u{2029}')
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
/// fixed notation for 1e-6 <= |v| < 1e21, exponent notation outside it,
/// integral values within 2^53 as plain integers. Rust's `{}` never emits
/// exponent notation and saturates `as i64` at 2^63, so the formatting is
/// built explicitly here.
pub fn js_num_to_string(v: f64) -> String {
    if !v.is_finite() {
        return "null".into(); // JS JSON.stringify(NaN/Infinity) is null
    }
    if v == 0.0 {
        return "0".into();
    }
    let a = v.abs();
    // Integral and within exact-integer range: plain integer form (JS does
    // this up to 1e21, but beyond 2^53 integers are not exactly representable
    // anyway; the shortest-round-trip path below handles those).
    if v == v.trunc() && a < 9.007_199_254_740_992e15 {
        return format!("{}", v as i64);
    }
    if a >= 1e21 || a < 1e-6 {
        return js_exp_format(v);
    }
    // Fixed notation with the shortest mantissa that round-trips.
    shortest_fixed(v)
}

/// JS exponent form: shortest mantissa + `e+NN` / `e-NN` (two-digit minimum).
fn js_exp_format(v: f64) -> String {
    // ryu gives the shortest round-trip mantissa and exponent.
    let raw = format!("{:e}", v); // e.g. "1e21", "1.5e-7"
    let (mantissa, exp) = raw.split_once('e').expect("{:e} always contains e");
    let e: i32 = exp.parse().unwrap_or(0);
    let sign = if e < 0 { "-" } else { "+" };
    // JS: no zero padding; single digit below 10 (1e-7), two above (1e+21).
    if e.abs() < 10 {
        format!("{}e{}{}", mantissa.trim_end_matches(".0"), sign, e.abs())
    } else {
        format!("{}e{}{:02}", mantissa.trim_end_matches(".0"), sign, e.abs())
    }
}

/// Shortest decimal string in fixed notation that round-trips to `v`.
fn shortest_fixed(v: f64) -> String {
    for prec in 0..=17 {
        let s = format!("{:.*}", prec, v);
        if s.parse::<f64>() == Ok(v) {
            return trim_fixed_zeros(&s);
        }
    }
    // Unreachable: 17 significant digits always round-trip.
    format!("{}", v)
}

/// Strip trailing zeros after the decimal point (and a bare trailing dot).
fn trim_fixed_zeros(s: &str) -> String {
    if !s.contains('.') {
        return s.to_string();
    }
    let t = s.trim_end_matches('0').trim_end_matches('.');
    t.to_string()
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

/// True when any number anywhere in the parsed JSON value is non-finite
/// (serde_json accepts 1e999 as infinity; it cannot round-trip).
fn has_non_finite(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Number(n) => !n.as_f64().map_or(true, f64::is_finite),
        serde_json::Value::Array(items) => items.iter().any(has_non_finite),
        serde_json::Value::Object(entries) => entries.values().any(has_non_finite),
        _ => false,
    }
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


#[cfg(test)]
mod js_num_tests {
    use super::js_num_to_string;

    #[test]
    fn js_number_formatting_matches_node() {
        assert_eq!(js_num_to_string(1e21), "1e+21");
        assert_eq!(js_num_to_string(1e-7), "1e-7");
        assert_eq!(js_num_to_string(1.5e-7), "1.5e-7");
        assert_eq!(js_num_to_string(1e19), "10000000000000000000");
        assert_eq!(js_num_to_string(1e20), "100000000000000000000");
        assert_eq!(js_num_to_string(9.3e20), "930000000000000000000");
        assert_eq!(js_num_to_string(12.0), "12");
        assert_eq!(js_num_to_string(0.5), "0.5");
        assert_eq!(js_num_to_string(0.000001), "0.000001");
        assert_eq!(js_num_to_string(0.0000001), "1e-7");
        assert_eq!(js_num_to_string(-2.5), "-2.5");
        assert_eq!(js_num_to_string(1e15), "1000000000000000");
        assert_eq!(js_num_to_string(1.7976931348623157e308), "1.7976931348623157e+308");
        assert_eq!(js_num_to_string(5e-324), "5e-324");
        assert_eq!(js_num_to_string(123456.789), "123456.789");
        assert_eq!(js_num_to_string(0.1), "0.1");
        assert_eq!(js_num_to_string(1e-5), "0.00001");
        assert_eq!(js_num_to_string(-1e21), "-1e+21");
        assert_eq!(js_num_to_string(123e30), "1.23e+32");
        assert_eq!(js_num_to_string(0.3), "0.3");
    }
}

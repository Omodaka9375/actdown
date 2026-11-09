//! Canonical text form (SPEC 10) and AST JSON (SPEC 9). Byte-for-byte port
//! of the TypeScript printer: attributes sorted with `on:` last, body fields
//! in reserved order then alphabetical, generated ids are
//! `h<sha1(canonical-block-without-id)[0:10]>`, and INV-3 idempotence.

use sha1::{Digest, Sha1};

use crate::parse::parse;
use crate::types::{AttrValue, BlockNode, Doc, Node};

const RESERVED: [&str; 4] = ["id", "role", "when", "each"];

fn attr_string(v: &AttrValue) -> String {
    match v {
        AttrValue::Str(s) => s.clone(),
        AttrValue::Expr(e) => format!("{{{}}}", e.raw),
    }
}

/// JavaScript `encodeURIComponent`: leaves A-Z a-z 0-9 - _ . ! ~ * ' ( ) and
/// percent-encodes everything else as uppercase UTF-8 hex.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        let keep = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')');
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn encode_attr_val(v: &AttrValue) -> String {
    let s = attr_string(v);
    if s.chars().any(|c| matches!(c, '?' | '&' | '=' | '%' | '#' | '"' | '+' | '`') || c.is_whitespace()) {
        encode_uri_component(&s)
    } else {
        s
    }
}

fn attr_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let ae = usize::from(a.starts_with("on:"));
    let be = usize::from(b.starts_with("on:"));
    if ae != be {
        return ae.cmp(&be);
    }
    a.cmp(b)
}

fn field_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let ia = RESERVED.iter().position(|r| *r == a);
    let ib = RESERVED.iter().position(|r| *r == b);
    match (ia, ib) {
        (None, None) => a.cmp(b),
        _ => ia.unwrap_or(RESERVED.len()).cmp(&ib.unwrap_or(RESERVED.len())),
    }
}

pub fn print_block(b: &BlockNode, omit_id: bool) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut attr_entries: Vec<(&String, &AttrValue)> = b.attrs.iter().collect();
    attr_entries.sort_by(|(a, _), (c, _)| attr_cmp(a, c));
    let mut info = format!("```hdm-{}", b.block_type);
    if !attr_entries.is_empty() {
        let pairs: Vec<String> = attr_entries
            .iter()
            .map(|(k, v)| {
                let s = attr_string(v);
                if s.is_empty() {
                    k.to_string()
                } else {
                    format!("{}={}", k, encode_attr_val(v))
                }
            })
            .collect();
        info.push('?');
        info.push_str(&pairs.join("&"));
    }
    parts.push(info);
    if !omit_id {
        parts.push(format!("id: {}", b.id));
    }
    if let Some(role) = &b.role {
        parts.push(format!("role: {}", role));
    }
    let mut field_keys: Vec<&String> = b.fields.keys().collect();
    field_keys.sort_by(|a, b| field_cmp(a, b));
    for k in field_keys {
        parts.push(format!("{}: {}", k, crate::literal::print_literal(&b.fields[k])));
    }
    if let Some(body) = &b.body {
        parts.push("---".to_string());
        if !body.is_empty() {
            for line in body.split('\n') {
                parts.push(line.to_string());
            }
        }
    }
    parts.push(String::new());
    parts.push("```".to_string());
    parts.join("\n")
}

fn print_prose(md: &str) -> String {
    let lines: Vec<String> = md
        .split('\n')
        .map(|l| {
            let stripped = l.trim_end_matches([' ', '\t']);
            let removed = &l[stripped.len()..];
            // Exactly two trailing spaces is a hard break; everything else is stripped.
            if removed == "  " {
                l.to_string()
            } else {
                stripped.to_string()
            }
        })
        .collect();
    let mut lines = lines;
    while lines.first().map_or(false, |l| l.trim().is_empty()) {
        lines.remove(0);
    }
    while lines.last().map_or(false, |l| l.trim().is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

pub fn print(doc: &Doc) -> String {
    let parts: Vec<String> = doc
        .nodes
        .iter()
        .map(|n| match n {
            Node::Prose(p) => print_prose(&p.md),
            Node::Foreign(f) => f.raw.clone(),
            Node::Block(b) => print_block(b, false),
        })
        .collect();
    format!("{}\n", parts.join("\n\n"))
}

/// SPEC 2.3: generated ids hash the canonical block bytes, id omitted.
fn gen_id(b: &BlockNode) -> String {
    let bytes = print_block(b, true);
    let mut hasher = Sha1::new();
    hasher.update(bytes.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|byte| format!("{:02x}", byte)).collect();
    format!("h{}", &hex[..10])
}

pub fn canonicalize(doc: &Doc) -> Doc {
    let nodes = doc
        .nodes
        .iter()
        .map(|n| match n {
            Node::Block(b) if b.id.is_empty() => {
                let mut nb = b.clone();
                nb.id = gen_id(b);
                Node::Block(nb)
            }
            other => other.clone(),
        })
        .collect();
    Doc { hdm: doc.hdm, nodes }
}

pub fn format(input: &str) -> String {
    print(&canonicalize(&parse(input).doc))
}

/// SPEC 9: canonical AST serialization, two-space indent, trailing LF.
/// serde_json's pretty printer matches `JSON.stringify(x, null, 2)`.
pub fn to_json(doc: &Doc) -> String {
    let mut out = serde_json::to_string_pretty(doc).expect("doc is serializable");
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_ids_are_stable() {
        let input = "```hdm-state\ncount: 0\n```";
        let f1 = format(input);
        let f2 = format(&f1);
        assert_eq!(f1, f2, "INV-3 idempotence");
        assert!(f1.contains("id: h"), "{}", f1);
    }
}

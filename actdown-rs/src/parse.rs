//! The ad block grammar (SPEC 2/3/4): fenced blocks with `ad-<type>` info
//! strings, a `KEY: VALUE` field set, optional `---` body text, trigger
//! events, and error demotion to foreign blocks (SPEC 15). A faithful port
//! of the TypeScript reference parser.

use std::sync::OnceLock;

use indexmap::IndexMap;
use regex::Regex;

use crate::diag::{err, ParseError};
use crate::literal::parse_field;
use crate::types::{
    AttrValue, BlockNode, Diagnostic, Doc, Expr, FieldValue, ForeignNode, Node, ParseResult, Prose,
};

/// SPEC 8: semantic roles; private extensions use the `x-` prefix.
pub const ROLES: [&str; 15] = [
    "button", "link", "input", "label", "heading", "chart", "table", "image", "form", "region",
    "status", "nav", "danger", "primary", "secondary",
];

/// SPEC 3 (level 1) plus region (4) and manifest (7).
pub const KNOWN_TYPES: [&str; 14] = [
    "state", "text", "data", "action", "form", "field", "list", "table", "image", "link", "chart",
    "include", "region", "manifest",
];

pub const EVENTS: [&str; 4] = ["click", "submit", "change", "load"];

fn fence_open_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$").unwrap())
}

fn ad_info_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^ad-([a-z][a-z0-9-]*)(\?(.*))?$").unwrap())
}

fn event_attr_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^on:(click|submit|change|load)$").unwrap())
}

fn on_event_line_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^on:(click|submit|change|load):[ \t]*(.*)$").unwrap())
}

/// SPEC 4.3 field form: `on:submit="expr"` (equals + quoted expression).
fn on_event_eq_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"^on:(click|submit|change|load)=[ \t]*(.*)$"#).unwrap())
}

fn field_line_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^([a-z][a-z0-9-]*):[ \t]*(.*)$").unwrap())
}

fn sep_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^---[ \t]*$").unwrap())
}

fn id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z][a-z0-9-]*$").unwrap())
}

struct FenceRef {
    end: usize,
    info: String,
    backtick: bool,
}

fn scan_fence(lines: &[&str], i: usize) -> Option<FenceRef> {
    let m = fence_open_re().captures(lines[i])?;
    let marker = m.get(1)?.as_str();
    let ch = marker.as_bytes()[0];
    let close_len = marker.chars().count();
    let mut j = i + 1;
    while j < lines.len() {
        let l = lines[j];
        let trimmed = l.trim_start_matches(' ');
        let indent = l.len() - trimmed.len();
        if indent <= 3 && trimmed.starts_with(ch as char) {
            let run = trimmed.chars().take_while(|&c| c == ch as char).count();
            let after = &trimmed[run..];
            if run >= close_len && after.trim_matches([' ', '\t']).is_empty() {
                break;
            }
        }
        j += 1;
    }
    Some(FenceRef {
        end: j,
        info: m.get(2).map_or("", |g| g.as_str()).trim().to_string(),
        backtick: ch == b'`',
    })
}

/// JavaScript `decodeURIComponent`: invalid sequences throw -> E_BAD_INFO.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hi = (hex[0] as char).to_digit(16)?;
            let lo = (hex[1] as char).to_digit(16)?;
            out.push(((hi * 16) + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub fn parse(input: &str) -> ParseResult {
    let normalized = input.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut nodes: Vec<Node> = Vec::new();
    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut prose: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < lines.len() {
        let fence = match scan_fence(&lines, i) {
            None => {
                prose.push(lines[i]);
                i += 1;
                continue;
            }
            Some(f) => f,
        };
        let m = ad_info_re().captures(&fence.info);
        let is_ad = fence.backtick && m.is_some();
        let unclosed = fence.end >= lines.len();
        let last = if unclosed { lines.len() - 1 } else { fence.end };
        if !is_ad {
            // Not an ad block: preserve verbatim as prose (INV-1).
            for k in i..=last {
                prose.push(lines[k]);
            }
            i = fence.end + 1;
            continue;
        }
        let caps = m.unwrap();
        let block_type = caps.get(1).unwrap().as_str().to_string();
        let attr_str = caps.get(2).map_or("", |g| g.as_str());
        let body_end = if unclosed { lines.len() } else { fence.end };
        let inner: Vec<&str> = lines[i + 1..body_end].to_vec();
        let raw_end = body_end + usize::from(!unclosed);
        let raw = lines[i..raw_end].join("\n");
        let start_line = (i + 1) as u32;

        flush_prose(&mut prose, &mut nodes);

        let result = parse_block(&block_type, attr_str, &inner, start_line);
        match result {
            Ok(block) => {
                if !KNOWN_TYPES.contains(&block.block_type.as_str()) {
                    // SPEC 2.1: unknown types are preserved verbatim as foreign blocks.
                    nodes.push(Node::Foreign(ForeignNode {
                        kind: "block",
                        foreign: true,
                        block_type,
                        raw,
                        line: start_line,
                        diagnostic: None,
                    }));
                } else {
                    if !block.id.is_empty() {
                        if seen_ids.contains(&block.id) {
                            let e = err("E_DUP_ID", format!("duplicate id \"{}\"", block.id), start_line);
                            demote(&mut nodes, &mut diagnostics, &block_type, raw, start_line, &e);
                            i = fence.end + 1;
                            continue;
                        }
                        seen_ids.insert(block.id.clone());
                    }
                    nodes.push(Node::Block(block));
                }
            }
            Err(e) => demote(&mut nodes, &mut diagnostics, &block_type, raw, start_line, &e),
        }
        i = fence.end + 1;
    }
    flush_prose(&mut prose, &mut nodes);
    ParseResult { doc: Doc { ad: "0.1", nodes }, diagnostics }
}

fn demote(
    nodes: &mut Vec<Node>,
    diagnostics: &mut Vec<Diagnostic>,
    block_type: &str,
    raw: String,
    line: u32,
    e: &ParseError,
) {
    // SPEC 15: a parse error demotes the block to a foreign block.
    let diagnostic = Diagnostic { code: e.code.to_string(), message: e.message.clone(), line: e.line };
    nodes.push(Node::Foreign(ForeignNode {
        kind: "block",
        foreign: true,
        block_type: block_type.to_string(),
        raw,
        line,
        diagnostic: Some(diagnostic.clone()),
    }));
    diagnostics.push(diagnostic);
}

fn flush_prose(prose: &mut Vec<&str>, nodes: &mut Vec<Node>) {
    while prose.first().map_or(false, |l| l.trim().is_empty()) {
        prose.remove(0);
    }
    while prose.last().map_or(false, |l| l.trim().is_empty()) {
        prose.pop();
    }
    if !prose.is_empty() {
        nodes.push(Node::Prose(Prose { kind: "prose", md: prose.join("\n") }));
    }
    prose.clear();
}

fn parse_block(
    block_type: &str,
    attr_str: &str,
    inner: &[&str],
    start_line: u32,
) -> Result<BlockNode, ParseError> {
    let mut attrs: IndexMap<String, String> = IndexMap::new();
    if !attr_str.is_empty() {
        if !attr_str.starts_with('?') {
            return Err(err("E_BAD_INFO", "malformed info string", start_line));
        }
        for part in attr_str[1..].split('&') {
            if part.is_empty() {
                continue;
            }
            let (key, raw_val) = match part.find('=') {
                None => (part, ""),
                Some(eq) => (&part[..eq], &part[eq + 1..]),
            };
            let val = percent_decode(raw_val).ok_or_else(|| {
                err("E_BAD_INFO", format!("bad percent-encoding in attribute \"{}\"", key), start_line)
            })?;
            // TS throws E_DUPLICATE_KEY on repeated info attrs; silently
            // overwriting would make attr order load-bearing.
            if attrs.contains_key(key) {
                return Err(err("E_DUPLICATE_KEY", format!("duplicate attribute \"{}\"", key), start_line));
            }
            attrs.insert(key.to_string(), val);
        }
    }

    // Trigger events may arrive as info attrs or body fields (SPEC 4.2, 4.3).
    let mut events: IndexMap<String, String> = IndexMap::new();
    let event_keys: Vec<String> =
        attrs.keys().filter(|k| event_attr_re().is_match(k)).cloned().collect();
    for k in event_keys {
        let v = attrs.shift_remove(&k).unwrap();
        events.insert(k[3..].to_string(), v);
    }

    let sep_idx = inner.iter().position(|l| sep_re().is_match(l));
    let field_lines: &[&str] = match sep_idx {
        None => inner,
        Some(idx) => &inner[..idx],
    };
    let body_lines: Option<&[&str]> = sep_idx.map(|idx| &inner[idx + 1..]);

    struct RawField {
        value: String,
        line: u32,
    }
    let mut raw_fields: IndexMap<String, RawField> = IndexMap::new();
    let mut current_key: Option<String> = None;
    for (idx, ln) in field_lines.iter().enumerate() {
        let line_no = start_line + idx as u32 + 1;
        if let Some(ev) = on_event_line_re().captures(ln) {
            events.insert(
                ev.get(1).unwrap().as_str().to_string(),
                ev.get(2).unwrap().as_str().trim().to_string(),
            );
            current_key = None;
            continue;
        }
        // SPEC 4.3: `on:submit="expr"` (equals + quoted expression).
        if let Some(ev) = on_event_eq_re().captures(ln) {
            let mut v = ev.get(2).unwrap().as_str().trim().to_string();
            if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
                v = v[1..v.len() - 1].to_string();
            }
            events.insert(ev.get(1).unwrap().as_str().to_string(), v);
            current_key = None;
            continue;
        }
        if let Some(fm) = field_line_re().captures(ln) {
            let key = fm.get(1).unwrap().as_str().to_string();
            if raw_fields.contains_key(&key) {
                return Err(err("E_DUPLICATE_KEY", format!("duplicate field \"{}\"", key), line_no));
            }
            raw_fields.insert(
                key.clone(),
                RawField { value: fm.get(2).unwrap().as_str().trim().to_string(), line: line_no },
            );
            current_key = Some(key);
            continue;
        }
        let trimmed_start = ln.trim_start_matches([' ', '\t']);
        if ln.len() > trimmed_start.len() && !trimmed_start.is_empty() {
            if let Some(key) = &current_key {
                // Continuation: folded into the current value with a single space.
                let cur = raw_fields.get_mut(key).unwrap();
                cur.value = format!("{} {}", cur.value, trimmed_start.trim());
                continue;
            }
        }
        if ln.trim_matches([' ', '\t']).is_empty() {
            current_key = None;
            continue;
        }
        return Err(err(
            "E_BAD_FIELD",
            format!("expected \"key: value\" line, got: {}", ln.trim()),
            line_no,
        ));
    }

    if events.len() > 1 {
        return Err(err(
            "E_MULTI_EVENT",
            format!(
                "multiple trigger events: {}",
                events.keys().cloned().collect::<Vec<_>>().join(", ")
            ),
            start_line,
        ));
    }

    let mut fields: IndexMap<String, FieldValue> = IndexMap::new();
    for (k, rf) in &raw_fields {
        fields.insert(k.clone(), parse_field(&rf.value, rf.line)?);
    }

    let mut id = String::new();
    if let Some(attr_id) = attrs.shift_remove("id") {
        id = attr_id;
    }
    if let Some(v) = fields.shift_remove("id") {
        match v {
            FieldValue::Lit(Literal::Str(s)) => id = s,
            _ => return Err(err("E_BAD_ID", "id must be a plain name", start_line)),
        }
    }
    if !id.is_empty() && !id_re().is_match(&id) {
        return Err(err("E_BAD_ID", format!("invalid id \"{}\"", id), start_line));
    }

    let mut role: Option<String> = None;
    if let Some(attr_role) = attrs.shift_remove("role") {
        role = Some(attr_role);
    }
    if let Some(v) = fields.shift_remove("role") {
        match v {
            FieldValue::Lit(Literal::Str(s)) => role = Some(s),
            _ => return Err(err("E_BAD_ROLE", "role must be a plain name", start_line)),
        }
    }
    if let Some(r) = &role {
        if !ROLES.contains(&r.as_str()) && !r.starts_with("x-") {
            return Err(err("E_BAD_ROLE", format!("unknown role \"{}\"", r), start_line));
        }
    }

    // `when` / `each` are expressions; normalize them into fields (SPEC 10).
    for rk in ["when", "each"] {
        if let Some(av) = attrs.shift_remove(rk) {
            if av.is_empty() {
                return Err(err("E_BAD_LITERAL", format!("{} needs an expression", rk), start_line));
            }
            fields.insert(rk.to_string(), FieldValue::Expr(Expr::new(av)));
        }
    }

    let mut final_attrs: IndexMap<String, AttrValue> =
        attrs.into_iter().map(|(k, v)| (k, AttrValue::Str(v))).collect();
    for (ev, raw) in &events {
        let value =
            if raw.is_empty() { AttrValue::Str(String::new()) } else { AttrValue::Expr(Expr::new(raw.clone())) };
        final_attrs.insert(format!("on:{}", ev), value);
    }

    let body =
        body_lines.map(|ls| ls.join("\n").trim_end_matches('\n').to_string());

    Ok(BlockNode {
        kind: "block",
        block_type: block_type.to_string(),
        id,
        role,
        attrs: final_attrs,
        fields,
        body,
        line: start_line,
    })
}

use crate::types::Literal;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_simple_state_block() {
        let input = "```ad-state\ncount: 0\ntitle: \"Weekly report\"\ntags: [\"a\", \"b\"]\n```";
        let result = parse(input);
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
        match &result.doc.nodes[0] {
            Node::Block(b) => {
                assert_eq!(b.block_type, "state");
                assert!(matches!(b.fields.get("count"), Some(FieldValue::Lit(Literal::Num(n))) if *n == 0.0));
            }
            other => panic!("expected block, got {:?}", other),
        }
    }

    #[test]
    fn body_field_on_event() {
        let input = "```ad-form?id=contact&action=cap:contact-form@v1\nemail: input(email, required)\non:submit: cap.send(action, $fields)\n```";
        let result = parse(input);
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    }
}

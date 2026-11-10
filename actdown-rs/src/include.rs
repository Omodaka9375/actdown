//! ad-include inlining (SPEC 4.5): the AST stores the include reference;
//! inlining is a separate, explicit pass so a document's meaning is always
//! locally readable. Cycles are E_INCLUDE_CYCLE; a src that cannot be loaded
//! is E_INCLUDE_UNRESOLVED. `cap:` sources are host resources and stay
//! verbatim: the host resolves them at render time, not the filesystem.

use std::collections::HashSet;

use crate::diag::{err, ParseError};
use crate::parse::parse;
use crate::types::{Doc, FieldValue, Literal, Node};

pub struct InlineOptions<'a> {
    /// Resolve an include src to ad document text. Relative paths are
    /// resolved by the caller; an injected loader keeps hosts in control of
    /// which paths a document may read.
    pub loader: &'a dyn Fn(&str) -> Result<String, String>,
    /// Depth cap against runaway chains (the reference uses 16).
    pub max_depth: usize,
}

fn key_of(src: &str) -> &str {
    let t = src.trim();
    t.strip_prefix("./").unwrap_or(t)
}

pub fn inline_includes(doc: &Doc, opts: &InlineOptions) -> Result<Doc, ParseError> {
    inline_doc(doc, &mut HashSet::new(), 0, opts)
}

fn inline_doc(
    doc: &Doc,
    stack: &mut HashSet<String>,
    depth: usize,
    opts: &InlineOptions,
) -> Result<Doc, ParseError> {
    if depth > opts.max_depth {
        return Err(err(
            "E_INCLUDE_CYCLE",
            "include depth exceeded (possible cycle)",
            0,
        ));
    }
    let mut nodes: Vec<Node> = Vec::new();
    for n in &doc.nodes {
        let b = match n {
            Node::Block(b) => b,
            other => {
                nodes.push(other.clone());
                continue;
            }
        };
        if b.block_type != "include" {
            nodes.push(Node::Block(b.clone()));
            continue;
        }
        let src = match b.fields.get("src") {
            Some(FieldValue::Lit(Literal::Str(s))) if !s.is_empty() => s.clone(),
            _ => {
                return Err(err(
                    "E_INCLUDE_UNRESOLVED",
                    &format!("ad-include \"{}\" has no string src field", b.id),
                    b.line,
                ));
            }
        };
        if src.starts_with("cap:") {
            // SPEC 4.5: the AST stores the reference.
            nodes.push(Node::Block(b.clone()));
            continue;
        }
        let key = key_of(&src).to_string();
        if stack.contains(&key) {
            return Err(err(
                "E_INCLUDE_CYCLE",
                &format!("include cycle through \"{}\"", src),
                b.line,
            ));
        }
        let text = (opts.loader)(&src)
            .map_err(|m| err("E_INCLUDE_UNRESOLVED", &format!("cannot resolve include \"{}\": {}", src, m), b.line))?;
        let inner = parse(&text);
        // The included document's own demoted blocks stay foreign (visible);
        // its ids collide the same way any pasted content would (canonicalize
        // de-duplicates, SPEC 2.3).
        stack.insert(key.clone());
        let spliced = inline_doc(&inner.doc, stack, depth + 1, opts)?;
        stack.remove(&key);
        nodes.extend(spliced.nodes);
    }
    Ok(Doc { ad: "0.1", nodes })
}

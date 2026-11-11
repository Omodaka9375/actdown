//! Parse errors (SPEC 15). A parse error demotes the offending block to a
//! foreign block; the document MUST still render.

use std::fmt;

use crate::react::parse_each;
use crate::types::{Diagnostic, Doc, FieldValue, Node};

#[derive(Debug, Clone)]
pub struct ParseError {
    pub code: &'static str,
    pub message: String,
    pub line: u32,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {} (line {})", self.code, self.message, self.line)
    }
}

impl std::error::Error for ParseError {}

pub fn err(code: &'static str, message: impl Into<String>, line: u32) -> ParseError {
    ParseError { code, message: message.into(), line }
}

fn is_expr_field(v: &FieldValue) -> bool {
    matches!(v, FieldValue::Expr(_))
}

fn expr_raw(v: &FieldValue) -> Option<&str> {
    match v {
        FieldValue::Expr(e) => Some(&e.raw),
        _ => None,
    }
}

/// Static review lints (non-fatal, `W_` prefixed) mirrored from the
/// TypeScript reference implementation's `lint()` in src/diag.ts:
///
/// - `W_REGION_FOR`: an ad-region points at a block id that does not exist.
/// - `W_EXPR_SYNTAX`: a `when=` guard (or the expression part of an `each=`
///   declaration) does not parse, so the block would render with the guard
///   ignored rather than applied.
/// - `W_CAP_UNDECLARED`: an action names a capability that no ad-manifest
///   in the document declares (the host may still grant it; this flags
///   drift).
pub fn lint(doc: &Doc) -> Vec<Diagnostic> {
    let mut out: Vec<Diagnostic> = Vec::new();
    let mut ids: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut declared: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for n in &doc.nodes {
        let Node::Block(b) = n else { continue };
        ids.insert(b.id.as_str());
        if b.block_type == "manifest" {
            if let Some(FieldValue::Lit(crate::types::Literal::Str(name))) = b.fields.get("name") {
                if !name.is_empty() {
                    declared.insert(name.as_str());
                }
            }
        }
    }
    for n in &doc.nodes {
        let Node::Block(block) = n else { continue };
        if block.block_type == "region" {
            if let Some(FieldValue::Lit(crate::types::Literal::Str(for_val))) = block.fields.get("for") {
                if !for_val.is_empty() && !ids.contains(for_val.as_str()) {
                    out.push(Diagnostic {
                        code: "W_REGION_FOR".to_string(),
                        message: format!(
                            "ad-region \"for: {for_val}\" references a block id that does not exist"
                        ),
                        line: block.line,
                    });
                }
            }
        }
        // when=/each= are expressions normalized into fields (SPEC 10). For
        // `each`, the field is a repetition declaration (`item in expr`):
        // lint only the expression portion, so a valid declaration is not
        // flagged.
        for key in ["when", "each"] {
            let Some(v) = block.fields.get(key) else { continue };
            if !is_expr_field(v) {
                continue;
            }
            let raw = expr_raw(v).unwrap_or_default();
            let to_check: Option<String> = if key == "each" {
                parse_each(raw).map(|(_, _, expr)| expr)
            } else {
                Some(raw.to_string())
            };
            let Some(to_check) = to_check else { continue };
            if let Err(e) = crate::expr::parse_expr(&to_check) {
                out.push(Diagnostic {
                    code: "W_EXPR_SYNTAX".to_string(),
                    message: format!("{key}=\"{raw}\" does not parse: {e}"),
                    line: block.line,
                });
            }
        }
        if block.block_type == "action" {
            let cap = match block.attrs.get("name") {
                Some(crate::types::AttrValue::Str(s)) => s.as_str(),
                _ => "",
            };
            if !cap.is_empty() && !declared.contains(cap) {
                out.push(Diagnostic {
                    code: "W_CAP_UNDECLARED".to_string(),
                    message: format!(
                        "action \"{}\" names capability \"{cap}\" which no ad-manifest declares",
                        block.id
                    ),
                    line: block.line,
                });
            }
        }
    }
    out
}

//! SPEC 5/6: document-level reactivity. `compute_state` resolves the flat
//! state map (literal entries pass through, expression entries are evaluated
//! in order, level-3 computed state). `render_reactive` renders the document
//! with the current state applied: bindings carry their value, `when=` hides
//! nodes, `each=` repeats them.

use regex::Regex;
use std::sync::OnceLock;

use crate::expr::{eval_expr, EvalContext, ExprError};
use crate::render::{render_node, PhaseMap, RenderCtx};
use crate::types::{BlockNode, Doc, FieldValue, Literal, Node, Scope};

/// Resolve the document's flat state map (SPEC 5). `state` blocks are applied
/// in document order; literal fields are taken as-is, expression fields are
/// evaluated against the state accumulated so far (computed state, level 3).
/// Later entries override earlier ones.
pub fn compute_state(doc: &Doc, initial: Option<&Scope>) -> Result<Scope, ExprError> {
    let mut scope: Scope = initial.cloned().unwrap_or_default();
    for n in &doc.nodes {
        let Node::Block(b) = n else { continue };
        if b.block_type != "state" && b.block_type != "data" {
            continue;
        }
        for (k, v) in &b.fields {
            match v {
                FieldValue::Expr(e) => {
                    let value = eval_expr(&e.raw, &mut EvalContext::render(&scope))?;
                    scope.insert(k.clone(), value);
                }
                FieldValue::Lit(lit) => {
                    scope.insert(k.clone(), lit.clone());
                }
            }
        }
    }
    Ok(scope)
}

/// `each="item in expr"` or `each="item, index in expr"` (SPEC 5).
fn parse_each(raw: &str) -> Option<(String, String, String)> {    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^([a-z][a-z0-9-]*)(?:\s*,\s*([a-z][a-z0-9-]*))?\s+in\s+(.+)$").unwrap()
    });
    let m = re.captures(raw.trim())?;
    Some((
        m.get(1)?.as_str().to_string(),
        m.get(2).map_or_else(|| "index".to_string(), |g| g.as_str().to_string()),
        m.get(3)?.as_str().to_string(),
    ))
}

fn eval_raw(raw: &str, scope: &Scope) -> Result<Literal, ExprError> {
    eval_expr(raw, &mut EvalContext::render(scope))
}

fn truthy(v: &Literal) -> bool {
    match v {
        Literal::Null => false,
        Literal::Bool(b) => *b,
        Literal::Num(n) => *n != 0.0 && !n.is_nan(),
        Literal::Str(s) => !s.is_empty(),
        Literal::Arr(items) => !items.is_empty(),
        Literal::Obj(entries) => !entries.is_empty(),
    }
}

/// Render a document with its state applied (SPEC 5/11): the server-side
/// render pass that a runtime hydrates. Hidden nodes render nothing.
pub fn render_with_state(doc: &Doc, scope: &Scope) -> Result<String, ExprError> {
    render_with_ctx(doc, scope, None)
}

/// Render with a phase map: matching phase regions are unhidden (SPEC 4/7).
pub fn render_with_phases(
    doc: &Doc,
    scope: &Scope,
    phases: &PhaseMap,
) -> Result<String, ExprError> {
    render_with_ctx(doc, scope, Some(phases))
}

fn render_with_ctx(
    doc: &Doc,
    scope: &Scope,
    phases: Option<&PhaseMap>,
) -> Result<String, ExprError> {
    let mut parts = Vec::new();
    for n in &doc.nodes {
        let s = render_reactive_node_ctx(n, scope, phases)?;
        if !s.is_empty() {
            parts.push(s);
        }
    }
    Ok(parts.join("\n"))
}

fn render_reactive_node_ctx(n: &Node, scope: &Scope, phases: Option<&PhaseMap>) -> Result<String, ExprError> {
    let Node::Block(b) = n else {
        return Ok(render_node(n, RenderCtx { env: Some(scope), phases }));
    };

    // SPEC 5: `when="expr"` hides the node when the expression is falsy.
    if let Some(when) = b.fields.get("when") {
        let v = match when {
            FieldValue::Expr(e) => eval_raw(&e.raw, scope)?,
            FieldValue::Lit(lit) => lit.clone(),
        };
        if !truthy(&v) {
            return Ok(String::new());
        }
    }

    // SPEC 5: `each="item in expr"` repeats the node, keyed by id. The field
    // may arrive as an expression (braced) or a plain string body field.
    if let Some(each) = b.fields.get("each") {
        let raw_each = match each {
            FieldValue::Expr(e) => Some(e.raw.clone()),
            FieldValue::Lit(Literal::Str(s)) => Some(s.clone()),
            _ => None,
        };
        if let Some(raw_each) = raw_each {
            let Some((item_name, index_name, expr)) = parse_each(&raw_each) else {
                return Ok(render_node(n, RenderCtx { env: Some(scope), phases }));
            };
            let items = eval_raw(&expr, scope)?;
            let Literal::Arr(items) = items else { return Ok(String::new()) };
            let mut parts = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                let mut clone: BlockNode = b.clone();
                clone.id = format!("{}-{}", b.id, index);
                let mut inner: Scope = scope.clone();
                inner.insert(item_name.clone(), item.clone());
                inner.insert(index_name.clone(), Literal::Num(index as f64));
                parts.push(render_node(
                    &Node::Block(clone),
                    RenderCtx { env: Some(&inner), phases },
                ));
            }
            return Ok(parts.join("\n"));
        }
    }

    Ok(render_node(n, RenderCtx { env: Some(scope), phases }))
}

/// Render a document with its state resolved and applied (SPEC 5/11).
pub fn render_reactive(doc: &Doc) -> Result<String, ExprError> {
    let scope = compute_state(doc, None)?;
    render_with_state(doc, &scope)
}

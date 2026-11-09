//! SPEC 7/11: the runtime. It keeps the flat state map authoritative over
//! document state-block literals (renderWithState), re-renders all bindings
//! in one pass on every change (no torn reads, SPEC 5), and routes
//! capabilities opt-in by name (SEC-1). Port of the TypeScript runtime with
//! one honest difference: Rust capabilities are synchronous, so the phase
//! map records success/failure around each call instead of pending.

use crate::expr::{evaluate, parse_expr, EvalContext, ExprError};
use crate::react::{compute_state, render_with_phases};
use crate::render::PhaseMap;
use crate::types::{AttrValue, BlockNode, Doc, FieldValue, Literal, Scope};

/// SEC-2: a capability receives the data args and a snapshot of state, and
/// returns its value plus an optional state patch. It never receives code.
pub type CapFn = dyn Fn(&Literal, &Scope) -> Result<CapResult, RuntimeError> + Send + Sync;

#[derive(Debug, Clone)]
pub struct CapResult {
    /// The value a `cap.send(...)` expression evaluates to.
    pub value: Literal,
    /// State keys to merge into the runtime scope (SPEC 5).
    pub patch: Scope,
}

impl CapResult {
    pub fn value(v: impl Into<Literal>) -> Self {
        CapResult { value: v.into(), patch: Scope::new() }
    }

    pub fn patch(patch: Scope) -> Self {
        CapResult { value: Literal::Null, patch }
    }
}

/// The granted capability registry (SEC-1): names map to implementations;
/// a document can only invoke what is granted here.
#[derive(Default)]
pub struct CapabilityRegistry {
    caps: std::collections::HashMap<String, Box<CapFn>>,
}

impl CapabilityRegistry {
    pub fn new() -> Self {
        CapabilityRegistry { caps: std::collections::HashMap::new() }
    }

    pub fn grant(
        mut self,
        name: &str,
        f: impl Fn(&Literal, &Scope) -> Result<CapResult, RuntimeError> + Send + Sync + 'static,
    ) -> Self {
        self.caps.insert(name.to_string(), Box::new(f));
        self
    }

    fn get(&self, name: &str) -> Option<&CapFn> {
        self.caps.get(name).map(|b| b.as_ref())
    }
}

#[derive(Debug, Clone)]
pub enum RuntimeError {
    /// SEC-1: the document named a capability that is not granted.
    CapMissing(String),
    /// fire() named a block the document does not contain.
    NoBlock(String),
    /// An `on:` expression failed (budgets, bindings, type errors).
    Expr(ExprError),
}

impl RuntimeError {
    pub fn code(&self) -> &'static str {
        match self {
            RuntimeError::CapMissing(_) => "E_CAP_MISSING",
            RuntimeError::NoBlock(_) => "E_NO_BLOCK",
            RuntimeError::Expr(e) => e.code,
        }
    }
}

impl std::fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RuntimeError::CapMissing(name) => write!(f, "capability not granted: {}", name),
            RuntimeError::NoBlock(id) => write!(f, "no block with id \"{}\"", id),
            RuntimeError::Expr(e) => write!(f, "{}", e),
        }
    }
}

impl std::error::Error for RuntimeError {}

fn find_block<'a>(doc: &'a Doc, id: &str) -> Option<&'a BlockNode> {
    doc.nodes.iter().find_map(|n| match n {
        crate::types::Node::Block(b) if b.id == id => Some(b),
        _ => None,
    })
}

fn run_capability(
    caps: &CapabilityRegistry,
    name: &str,
    args: Literal,
    scope: &mut Scope,
    phases: &mut PhaseMap,
    block_id: &str,
) -> Result<Literal, RuntimeError> {
    let f = caps.get(name).ok_or_else(|| RuntimeError::CapMissing(name.to_string()))?;
    let snapshot = scope.clone();
    match f(&args, &snapshot) {
        Ok(res) => {
            for (k, v) in res.patch {
                scope.insert(k, v);
            }
            phases.insert(block_id.to_string(), "success".into());
            Ok(res.value)
        }
        Err(e) => {
            phases.insert(block_id.to_string(), "failure".into());
            Err(e)
        }
    }
}

/// Hydrate a document: attach capabilities by block id and keep the flat
/// state map. Document state-block literals seed the scope once, here;
/// afterwards the runtime's map is authoritative (SPEC 5).
pub fn hydrate(doc: Doc, caps: &CapabilityRegistry) -> Runtime<'_> {
    hydrate_with_initial(doc, caps, Scope::new())
}

pub fn hydrate_with_initial(doc: Doc, caps: &CapabilityRegistry, initial: Scope) -> Runtime<'_> {
    let scope = compute_state(&doc, Some(&initial)).unwrap_or_default();
    Runtime { doc, scope, phases: PhaseMap::new(), caps }
}

pub struct Runtime<'a> {
    doc: Doc,
    scope: Scope,
    phases: PhaseMap,
    caps: &'a CapabilityRegistry,
}

impl<'a> Runtime<'a> {
    /// Current flat state (SPEC 5).
    pub fn state(&self) -> &Scope {
        &self.scope
    }

    /// Current async phase per block id: success | failure (pending is the
    /// TypeScript runtime's await window; Rust capabilities are sync).
    pub fn phases(&self) -> &PhaseMap {
        &self.phases
    }

    /// Apply a state patch and re-render all bindings in one pass (SPEC 5).
    pub fn set(&mut self, patch: Scope) {
        for (k, v) in patch {
            self.scope.insert(k, v);
        }
    }

    /// Current reactive HTML (SPEC 11) with phase regions applied.
    pub fn html(&self) -> Result<String, ExprError> {
        render_with_phases(&self.doc, &self.scope, &self.phases)
    }

    /**
     * Fire a block's `on:<event>` expression with `$name` payload available.
     * A plain `hdm-action` (no `on:` expression) fires its `name` capability
     * with its `args` field (SPEC 4.2); a plain `hdm-form` fires its `action`
     * capability with the submitted fields (SPEC 4.3).
     */
    pub fn fire(
        &mut self,
        block_id: &str,
        event: &str,
        dollar: Option<&Scope>,
    ) -> Result<Literal, RuntimeError> {
        let block =
            find_block(&self.doc, block_id).ok_or_else(|| RuntimeError::NoBlock(block_id.to_string()))?.clone();
        let caps = self.caps;

        let on_expr = match block.attrs.get(&format!("on:{}", event)) {
            Some(AttrValue::Expr(e)) if !e.raw.is_empty() => Some(e.raw.clone()),
            _ => None,
        };

        if let Some(raw) = on_expr {
            // SPEC 6: `on:` attributes evaluate expressions; cap.send routes
            // to caps. The block's own string attrs (e.g. a form's `action`)
            // are visible as names; state shadows them.
            let mut merged: Scope = Scope::new();
            for (k, v) in &block.attrs {
                if let AttrValue::Str(s) = v {
                    merged.insert(k.clone(), Literal::Str(s.clone()));
                }
            }
            for (k, v) in &self.scope {
                merged.insert(k.clone(), v.clone());
            }
            let scope = &mut self.scope;
            let phases = &mut self.phases;
            let mut send = |name: &str, args: Literal| -> Result<Literal, ExprError> {
                run_capability(caps, name, args, scope, phases, block_id)
                    .map_err(|e| ExprError::new(e.code(), e.to_string()))
            };
            let ast = parse_expr(&raw).map_err(RuntimeError::Expr)?;
            let mut ctx = EvalContext { scope: &merged, dollar, send: Some(&mut send), max_steps: crate::expr::DEFAULT_MAX_STEPS, max_depth: crate::expr::DEFAULT_MAX_DEPTH };
            return evaluate(&ast, &mut ctx).map_err(RuntimeError::Expr);
        }

        // SPEC 4.2: a plain action fires its named capability with data args.
        if event == "click" && block.block_type == "action" {
            if let Some(AttrValue::Str(name)) = block.attrs.get("name") {
                let args = match block.fields.get("args") {
                    Some(FieldValue::Lit(lit)) => lit.clone(),
                    _ => Literal::Null,
                };
                return run_capability(caps, name, args, &mut self.scope, &mut self.phases, block_id);
            }
            return Ok(Literal::Null);
        }

        // SPEC 4.3: a plain form fires its `action` capability with the fields.
        if event == "submit" && block.block_type == "form" {
            if let Some(AttrValue::Str(action)) = block.attrs.get("action") {
                let fields =
                    dollar.and_then(|d| d.get("fields")).cloned().unwrap_or(Literal::Null);
                return run_capability(caps, action, fields, &mut self.scope, &mut self.phases, block_id);
            }
        }
        Ok(Literal::Null)
    }

    /// Submit a form block (SPEC 4.3): `$fields` bound to the field values.
    pub fn submit(&mut self, form_id: &str, fields: Scope) -> Result<Literal, RuntimeError> {
        let mut dollar = Scope::new();
        dollar.insert("fields".to_string(), Literal::Obj(fields));
        self.fire(form_id, "submit", Some(&dollar))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const COUNTER: &str = "# Counter\n\n```hdm-state\ncount: 0\n```\n\n```hdm-action?name=counter.inc&role=primary\nid: inc\n---\nAdd one ({count})\n```\n\nCount is {count}.\n";

    const SAVE: &str = "# Save\n\n```hdm-action?name=doc.save\nid: save\n---\nSave now\n```\n\n```hdm-region\nfor: save\nphase: failure\n---\nCould not save.\n```\n";

    fn doc(src: &str) -> Doc {
        crate::parse::parse(src).doc
    }

    #[test]
    fn fires_capabilities_by_id_and_updates_bindings() {
        let caps = CapabilityRegistry::new().grant("counter.inc", |_args, state| {
            let count = match state.get("count") {
                Some(Literal::Num(n)) => *n,
                _ => 0.0,
            };
            let mut patch = Scope::new();
            patch.insert("count".into(), Literal::Num(count + 1.0));
            Ok(CapResult::patch(patch))
        });
        let mut rt = hydrate(doc(COUNTER), &caps);
        assert_eq!(rt.state().get("count"), Some(&Literal::Num(0.0)));
        rt.fire("inc", "click", None).unwrap();
        assert_eq!(rt.state().get("count"), Some(&Literal::Num(1.0)));
        let html = rt.html().unwrap();
        assert!(html.contains("data-hdm-bind=\"count\">1</span>"), "{}", html);
    }

    #[test]
    fn runtime_state_wins_over_document_literals() {
        let caps = CapabilityRegistry::new();
        let mut rt = hydrate(doc(COUNTER), &caps);
        let mut patch = Scope::new();
        patch.insert("count".into(), Literal::Num(7.0));
        rt.set(patch);
        let html = rt.html().unwrap();
        assert!(html.contains("data-hdm-bind=\"count\">7</span>"), "{}", html);
    }

    #[test]
    fn on_expressions_see_payload_and_block_attrs() {
        // on:click=cap.send("echo.set", {value: $value})
        let src = "```hdm-action?name=echo.set&on:click=cap.send(\"echo.set\", {value: $value})\nid: echo\n---\nEcho\n```";
        let caps = CapabilityRegistry::new().grant("echo.set", |args, _state| {
            let value = match args {
                Literal::Obj(entries) => entries.get("value").cloned().unwrap_or(Literal::Null),
                _ => Literal::Null,
            };
            let mut patch = Scope::new();
            patch.insert("last".into(), value);
            Ok(CapResult::patch(patch))
        });
        let mut rt = hydrate(doc(src), &caps);
        let mut dollar = Scope::new();
        dollar.insert("value".into(), Literal::Str("hi".into()));
        rt.fire("echo", "click", Some(&dollar)).unwrap();
        assert_eq!(rt.state().get("last"), Some(&Literal::Str("hi".into())));
    }

    #[test]
    fn refuses_capabilities_that_are_not_granted_sec_1() {
        let caps = CapabilityRegistry::new();
        let mut rt = hydrate(doc(COUNTER), &caps);
        let err = rt.fire("inc", "click", None).unwrap_err();
        assert_eq!(err.code(), "E_CAP_MISSING");
    }

    #[test]
    fn failures_are_visible_state_not_crashes() {
        let caps = CapabilityRegistry::new().grant("doc.save", |_args, _state| {
            Err(RuntimeError::CapMissing("disk full".into()))
        });
        let mut rt = hydrate(doc(SAVE), &caps);
        let err = rt.fire("save", "click", None).unwrap_err();
        assert_eq!(err.code(), "E_CAP_MISSING");
        assert_eq!(rt.phases().get("save").map(String::as_str), Some("failure"));
        let html = rt.html().unwrap();
        assert!(html.contains("Could not save."), "{}", html);
        assert!(html.contains("data-hdm-phase=\"failure\""), "{}", html);
        assert!(!html.contains("data-hdm-phase=\"failure\" hidden"), "{}", html);
    }

    #[test]
    fn form_submit_routes_to_action_with_fields() {
        let src = "```hdm-form?id=contact&action=cap:contact-form@v1\nemail: input(email, required)\non:submit: cap.send(action, $fields)\n```";
        let caps = CapabilityRegistry::new().grant("cap:contact-form@v1", |args, _state| {
            let mut patch = Scope::new();
            let email = match args {
                Literal::Obj(entries) => entries.get("email").cloned().unwrap_or(Literal::Null),
                _ => Literal::Null,
            };
            patch.insert("email".into(), email);
            Ok(CapResult::patch(patch))
        });
        let mut rt = hydrate(doc(src), &caps);
        let mut fields = Scope::new();
        fields.insert("email".into(), Literal::Str("a@b.c".into()));
        rt.submit("contact", fields).unwrap();
        assert_eq!(rt.state().get("email"), Some(&Literal::Str("a@b.c".into())));
        assert_eq!(rt.phases().get("contact").map(String::as_str), Some("success"));
    }

    #[test]
    fn unknown_block_ids_error() {
        let caps = CapabilityRegistry::new();
        let mut rt = hydrate(doc(COUNTER), &caps);
        let err = rt.fire("missing", "click", None).unwrap_err();
        assert_eq!(err.code(), "E_NO_BLOCK");
    }
}

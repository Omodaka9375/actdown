//! Parity regression tests mirroring test/regressions.test.ts (the fixes from
//! the 2026-11-10 security/correctness review). Each case documents the
//! behavior it locks to the TypeScript reference implementation.

use actdown::{
    compute_state, eval_expr, hydrate, hydrate_with_initial, parse, parse_field, parse_expr,
    render, render_reactive, CapabilityRegistry, CapResult, EvalContext, Literal, Scope,
};

fn scope(pairs: &[(&str, Literal)]) -> Scope {
    pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

fn eval(src: &str, s: &Scope) -> Literal {
    eval_expr(src, &mut EvalContext::render(s)).unwrap()
}

#[test]
fn inherited_properties_do_not_resolve_in_expressions() {
    let empty: Scope = Scope::new();
    assert_eq!(eval("{}.constructor", &empty), Literal::Null);
    assert_eq!(eval("{}[\"constructor\"]", &empty), Literal::Null);
}

#[test]
fn cap_registry_refuses_ungranted_capability() {
    // The registry is a HashMap (own keys only), so "constructor" cannot
    // resolve; firing an action whose capability is not granted must fail.
    let res = parse("```ad-action?name=constructor\nargs: {}\n---\nGo\n```");
    let caps = CapabilityRegistry::new().grant("other", |_a, _s| Ok(CapResult::done()));
    let id = match &res.doc.nodes[0] {
        actdown::Node::Block(b) => b.id.clone(),
        _ => panic!("expected a block"),
    };
    let mut rt = hydrate(res.doc, &caps).unwrap();
    let err = match rt.fire(&id, "click", None) {
        Err(e) => e,
        Ok(_) => panic!("fire must fail for an ungranted capability"),
    };
    assert_eq!(err.code(), "E_CAP_MISSING", "{err}");
}

#[test]
fn c0_controls_cannot_smuggle_a_script_scheme() {
    // Mirrors the TS safeUrl fix: leading C0 controls are stripped the way the
    // URL parser would before scheme validation.
    let res = parse("```ad-link\nhref: \"\u{1}javascript:alert(1)\"\n---\nx\n```");
    let html = render(&res.doc);
    assert!(html.contains("href=\"#\""), "{}", html);
}

#[test]
fn nested_non_finite_numbers_are_rejected() {
    // serde_json rejects out-of-range floats itself; parse_field surfaces it.
    assert!(parse_field("[1e400]", 1).is_err());
    assert!(parse_field("{\"a\": 1e999}", 1).is_err());
    assert_eq!(
        parse_field("[1, 2]", 1).unwrap(),
        actdown::FieldValue::Lit(Literal::Arr(vec![Literal::Num(1.0), Literal::Num(2.0)]))
    );
}

#[test]
fn data_blocks_publish_under_id_key() {
    let src = "```ad-data?id=catalog\nprice: 10\n```\n\n```ad-text\nbody: total {catalog.price}\n```";
    let doc = parse(src).doc;
    let s = compute_state(&doc, None).unwrap();
    assert_eq!(
        s.get("catalog"),
        Some(&Literal::Obj(scope(&[("price", Literal::Num(10.0))])))
    );
    let html = render_reactive(&doc).unwrap();
    assert!(
        html.contains("total <span data-ad-bind=\"catalog.price\">10</span>"),
        "{}",
        html
    );
}

#[test]
fn when_failures_contain_to_one_node() {
    let src = "```ad-text\nbody: before\n```\n\n```ad-action?name=a&when=nope%3F%3F\nid: act\n---\nLabel\n```\n\n```ad-text\nbody: after\n```";
    let html = render_reactive(&parse(src).doc).unwrap();
    assert!(html.contains("before"), "{}", html);
    assert!(html.contains("after"), "{}", html);
}

#[test]
fn on_submit_eq_form_parses_as_trigger() {
    let res = parse("```ad-form?id=contact&action=cap:cf@v1\nemail: input(email)\non:submit=\"cap.send(action, $fields)\"\n```");
    assert!(res.diagnostics.is_empty(), "{:?}", res.diagnostics);
    match &res.doc.nodes[0] {
        actdown::Node::Block(b) => {
            assert!(b.attrs.contains_key("on:submit"));
        }
        other => panic!("unexpected node kind"),
    }
}

#[test]
fn script_data_payloads_are_json_safe_not_entity_escaped() {
    let res = parse("```ad-data\ntitle: \"<b>bold</b>\"\n```");
    let html = render(&res.doc);
    assert!(html.contains("\\u003cb\\u003e"), "{}", html);
    assert!(!html.contains("&lt;b&gt;"), "{}", html);
}

#[test]
fn quoted_string_literals_display_without_source_quotes() {
    let res = parse("```ad-image\nsrc: \"https://example.com/x.png\"\nalt: \"Two words\"\n```");
    let html = render(&res.doc);
    assert!(html.contains("alt=\"Two words\""), "{}", html);
}

#[test]
fn three_trailing_spaces_normalize_to_hard_break() {
    let once = actdown::format("a   \nb");
    assert!(once.contains("a  \nb"), "{}", once);
    assert_eq!(actdown::format(&once), once);
}

#[test]
fn call_arguments_count_toward_the_parser_depth_budget() {
    let mut src = "cap.send".to_string();
    for _ in 0..100 {
        src = format!("cap.send(\"x\", {}?)", src);
    }
    assert!(parse_expr(&src).is_err());
}

#[test]
fn deep_equality_checks_own_keys() {
    let empty: Scope = Scope::new();
    assert_eq!(eval("{x: 1, y: 2} == {x: 1, y: 2, z: 3}", &empty), Literal::Bool(false));
    assert_eq!(eval("{x: 1, y: 2} == {x: 1, y: 2}", &empty), Literal::Bool(true));
}

#[test]
fn surrogate_pair_escapes_combine() {
    let empty: Scope = Scope::new();
    match eval("\"\\uD83D\\uDE00\"", &empty) {
        Literal::Str(s) => assert_eq!(s, "\u{1F600}"),
        other => panic!("expected string, got {:?}", other),
    }
}

#[test]
fn utf16_string_ordering_matches_js() {
    let empty: Scope = Scope::new();
    // An astral char (surrogate pair D83D DE00) sorts BELOW U+FFFD in JS.
    assert_eq!(eval("\"\\uD83D\\uDE00\" < \"\\uFFFD\"", &empty), Literal::Bool(true));
}

#[test]
fn computed_state_recomputes_after_patches() {
    let src = "```ad-state\ncount: 1\ntotal: {count + 1}\n```";
    let doc = parse(src).doc;
    let rt = hydrate(doc, &CapabilityRegistry::new()).unwrap();
    assert_eq!(rt.state().get("total"), Some(&Literal::Num(2.0)));
    // Re-hydrating with an initial simulates a patch (Rust caps are sync).
    let doc2 = parse(src).doc;
    let rt2 = hydrate_with_initial(
        doc2,
        &CapabilityRegistry::new(),
        scope(&[("count", Literal::Num(10.0))]),
    )
    .unwrap();
    assert_eq!(rt2.state().get("total"), Some(&Literal::Num(11.0)));
}
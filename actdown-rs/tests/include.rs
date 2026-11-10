//! ad-include inlining (SPEC 4.5): same fixtures as the TypeScript suite
//! (test/include.test.ts) so the two ports prove the same behavior.

use std::collections::HashMap;

use actdown::{canonicalize, inline_includes, parse, render, InlineOptions, ParseError};

const PARTIAL: &str = "## Payments\n\nRetry policy tightened.\n\n```ad-state\nretries: 3\n```\n";

fn loader<'a>(files: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Result<String, String> + 'a {
    let map: HashMap<&'a str, &'a str> = files.iter().copied().collect();
    move |src| match map.get(src) {
        Some(v) => Ok((*v).to_string()),
        None => Err(format!("no such file: {}", src)),
    }
}

fn inline_of(main: &str, files: &[(&str, &str)]) -> Result<actdown::Doc, ParseError> {
    let l = loader(files);
    inline_includes(&parse(main).doc, &InlineOptions { loader: &l, max_depth: 16 })
}

fn shape(doc: &actdown::Doc) -> Vec<String> {
    doc.nodes
        .iter()
        .map(|n| match n {
            actdown::Node::Prose(_) => "prose".to_string(),
            actdown::Node::Block(b) => b.block_type.clone(),
            actdown::Node::Foreign(_) => "foreign".to_string(),
        })
        .collect()
}

#[test]
fn splices_the_included_nodes_at_the_include_position() {
    let main = "# Report\n\n```ad-include\nsrc: partial.ad\n```\n\nDone.";
    let doc = inline_of(main, &[("partial.ad", PARTIAL)]).unwrap();
    assert_eq!(shape(&doc), vec!["prose", "prose", "state", "prose"]);
    let canonical = actdown::print(&canonicalize(&doc));
    assert!(!canonical.contains("ad-include"));
}

#[test]
fn leaves_cap_includes_verbatim() {
    let doc = inline_of("```ad-include\nsrc: cap:header@v1\n```", &[]).unwrap();
    assert_eq!(doc.nodes.len(), 1);
    match &doc.nodes[0] {
        actdown::Node::Block(b) => match b.fields.get("src") {
            Some(actdown::FieldValue::Lit(actdown::Literal::Str(s))) => assert_eq!(s, "cap:header@v1"),
            other => panic!("expected cap: src, got {:?}", other),
        },
        other => panic!("expected a block, got {:?}", other),
    }
}

#[test]
fn cycles_and_self_includes_are_e_include_cycle() {
    let cycle = inline_of(
        "```ad-include\nsrc: a.ad\n```",
        &[("a.ad", "```ad-include\nsrc: b.ad\n```"), ("b.ad", "```ad-include\nsrc: a.ad\n```")],
    );
    assert_eq!(cycle.unwrap_err().code, "E_INCLUDE_CYCLE");
    let self_include =
        inline_of("```ad-include\nsrc: me.ad\n```", &[("me.ad", "```ad-include\nsrc: me.ad\n```")]);
    assert_eq!(self_include.unwrap_err().code, "E_INCLUDE_CYCLE");
}

#[test]
fn diamond_includes_are_allowed() {
    let main = "```ad-include\nsrc: b.ad\n```\n\n```ad-include\nsrc: c.ad\n```";
    let doc = inline_of(
        main,
        &[
            ("b.ad", "```ad-include\nsrc: shared.ad\n```"),
            ("c.ad", "```ad-include\nsrc: shared.ad\n```"),
            ("shared.ad", "Shared text."),
        ],
    )
    .unwrap();
    assert_eq!(shape(&doc), vec!["prose", "prose"]);
}

#[test]
fn missing_files_and_missing_src_are_e_include_unresolved() {
    let missing = inline_of("```ad-include\nsrc: ghost.ad\n```", &[]);
    assert_eq!(missing.unwrap_err().code, "E_INCLUDE_UNRESOLVED");
    let no_src = inline_of("```ad-include\n---\nnot-src: x\n```", &[]);
    assert_eq!(no_src.unwrap_err().code, "E_INCLUDE_UNRESOLVED");
}

#[test]
fn nested_includes_splice() {
    let doc = inline_of(
        "```ad-include\nsrc: outer.ad\n```",
        &[("outer.ad", "Outer.\n\n```ad-include\nsrc: inner.ad\n```"), ("inner.ad", "Inner.")],
    )
    .unwrap();
    let texts: Vec<&str> = doc
        .nodes
        .iter()
        .filter_map(|n| match n {
            actdown::Node::Prose(p) => Some(p.md.as_str()),
            _ => None,
        })
        .collect();
    assert!(texts.contains(&"Outer."));
    assert!(texts.contains(&"Inner."));
}

#[test]
fn spliced_document_renders_like_pasted_content() {
    let doc = canonicalize(&inline_of("```ad-include\nsrc: p.ad\n```", &[("p.ad", PARTIAL)]).unwrap());
    let html = render(&doc);
    assert!(html.contains("<h2>Payments</h2>"));
    assert!(html.contains("Retry policy tightened."));
}

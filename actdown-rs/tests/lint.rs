//! Review lints, mirroring test/lint.test.ts in the reference
//! implementation. The Rust port does not run the CLI `check` path, but the
//! `lint()` surface must agree with TypeScript on what it flags so a
//! reviewer sees the same warnings on either implementation.

use actdown::{canonicalize, lint, parse};

fn codes_of(src: &str) -> Vec<String> {
    lint(&canonicalize(&parse(src).doc))
        .into_iter()
        .map(|d| d.code)
        .collect()
}

#[test]
fn flags_a_region_whose_for_references_a_missing_block_id() {
    let src = "```ad-region\nfor: ghost\nphase: pending\n---\nbusy\n```";
    let out = codes_of(src);
    assert_eq!(out, vec!["W_REGION_FOR".to_string()], "{out:?}");
}

#[test]
fn flags_an_unparseable_when_guard() {
    let src = "```ad-action?name=cap.x&when=1%20%2B\nid: a\n---\nGo\n```";
    let out = codes_of(src);
    assert!(out.iter().any(|c| c == "W_EXPR_SYNTAX"), "{out:?}");
}

#[test]
fn flags_actions_whose_capability_no_manifest_declares() {
    let src = "```ad-action?name=deploy.approve\nid: a\n---\nGo\n```";
    let out = codes_of(src);
    assert_eq!(out, vec!["W_CAP_UNDECLARED".to_string()], "{out:?}");
}

#[test]
fn is_clean_for_a_document_that_declares_its_capabilities_and_regions() {
    let src = [
        "```ad-manifest",
        "name: deploy.approve",
        "min-version: 1.0.0",
        "```",
        "",
        "```ad-action?name=deploy.approve",
        "id: approve",
        "---",
        "Go",
        "```",
        "",
        "```ad-region",
        "for: approve",
        "phase: pending",
        "---",
        "busy",
        "```",
    ]
    .join("\n");
    assert!(codes_of(&src).is_empty());
}

#[test]
fn ignores_foreign_blocks() {
    let src = "```ad-totally-unknown\nfor: ghost\n```";
    assert!(codes_of(src).is_empty());
}

#[test]
fn valid_each_declarations_are_not_flagged() {
    let src = "```ad-list?each=item%20in%20items\nid: l\n---\nbody\n```";
    let out = codes_of(src);
    assert!(out.iter().all(|c| c != "W_EXPR_SYNTAX"), "{out:?}");
}

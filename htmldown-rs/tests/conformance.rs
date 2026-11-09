//! Cross-language conformance (SPEC 13): the Rust implementation reads the
//! same vectors/ goldens the TypeScript implementation is tested against:
//! ast.json, canonical.hdm, html.html (level 1) and reactive.html (level 2+,
//! the state-applied render of SPEC 5/6).

use std::fs;
use std::path::PathBuf;

use htmldown::{canonicalize, format, parse, render, render_reactive, to_json};

fn vectors_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("vectors")
}

/// JSON parse with an explicit check (never assume shape).
fn manifest() -> serde_json::Map<String, serde_json::Value> {
    let raw = fs::read_to_string(vectors_root().join("manifest.json")).expect("read manifest.json");
    let v: serde_json::Value = serde_json::from_str(&raw).expect("manifest.json must be valid JSON");
    match v {
        serde_json::Value::Object(o) => match o.get("vectors") {
            Some(serde_json::Value::Object(vectors)) => vectors.clone(),
            other => panic!("manifest.json: vectors must be an object, got {:?}", other),
        },
        other => panic!("manifest.json: root must be an object, got {:?}", other),
    }
}

#[test]
fn conformance_vectors_level_1() {
    let manifest = manifest();
    assert!(!manifest.is_empty(), "no vectors listed");

    let mut results: Vec<String> = Vec::new();

    for (name, entry) in &manifest {
        let dir = vectors_root().join(name);
        let input = fs::read_to_string(dir.join("input.hdm"))
            .unwrap_or_else(|e| panic!("{}: {}", name, e));
        let level = entry.get("level").and_then(|l| l.as_u64()).expect("level");
        let goldens: Vec<String> = entry
            .get("goldens")
            .and_then(|g| g.as_array())
            .expect("goldens array")
            .iter()
            .map(|g| g.as_str().expect("golden name").to_string())
            .collect();

        let doc = parse(&input).doc;
        let cdoc = canonicalize(&doc);
        let ast = to_json(&cdoc);
        let canonical = format(&input);
        let html = format!("{}\n", render(&cdoc));

        // INV-3: canonicalization is idempotent.
        assert_eq!(format(&canonical), canonical, "{}: canonicalization not idempotent", name);

        for golden in &goldens {
            match golden.as_str() {
                "ast.json" => {
                    let expected = fs::read_to_string(dir.join(golden)).unwrap();
                    assert_eq!(ast, expected, "{}: ast.json differs", name);
                }
                "canonical.hdm" => {
                    let expected = fs::read_to_string(dir.join(golden)).unwrap();
                    assert_eq!(canonical, expected, "{}: canonical.hdm differs", name);
                }
                "html.html" => {
                    let expected = fs::read_to_string(dir.join(golden)).unwrap();
                    assert_eq!(html, expected, "{}: html.html differs", name);
                }
                "reactive.html" => {
                    let expected = fs::read_to_string(dir.join(golden)).unwrap();
                    let reactive = format!("{}\n", render_reactive(&cdoc).expect("reactive render"));
                    assert_eq!(reactive, expected, "{}: reactive.html differs", name);
                }
                other => panic!("unknown golden {} in {}", other, name),
            }
        }
        let _ = level;
        results.push(format!("pass {} (level {})", name, level));
    }

    for line in &results {
        println!("{}", line);
    }
}

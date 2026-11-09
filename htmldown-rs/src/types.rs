//! The AST (SPEC 9). Serialization mirrors the TypeScript implementation's
//! `JSON.stringify(doc, null, 2)` byte for byte: fixed key order, insertion
//! order inside attrs/fields maps, JS-style number formatting.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize, Serializer};

/// Serialize an f64 the way JavaScript's `JSON.stringify` does: integral
/// values in range print without a fraction (12 not 12.0). Note: JS switches
/// to exponent notation above 1e21 / below 1e-7; the spec's fixed-point
/// integer + IEEE 754 model keeps documents out of that regime.
pub fn js_num<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
    if !v.is_finite() {
        return s.serialize_unit(); // JSON.stringify(Infinity/NaN) is null, never a panic
    }
    if *v == v.trunc() && v.abs() < 9.007_199_254_740_992e15 {
        s.serialize_i64(*v as i64)
    } else {
        s.serialize_f64(*v)
    }
}

/// SPEC 4.1: number | string | boolean | null | array | object.
#[derive(Debug, Clone, PartialEq)]
pub enum Literal {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Literal>),
    Obj(IndexMap<String, Literal>),
}

impl Serialize for Literal {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Literal::Null => s.serialize_unit(),
            Literal::Bool(b) => s.serialize_bool(*b),
            Literal::Num(n) => js_num(n, s),
            Literal::Str(v) => s.serialize_str(v),
            Literal::Arr(items) => s.collect_seq(items),
            Literal::Obj(entries) => {
                let mut map = s.serialize_map(Some(entries.len()))?;
                for (k, v) in entries {
                    serde::ser::SerializeMap::serialize_entry(&mut map, k, v)?;
                }
                serde::ser::SerializeMap::end(map)
            }
        }
    }
}

/// A deferred expression: `{ "kind": "expr", "raw": ... }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Expr {
    pub kind: &'static str,
    pub raw: String,
}

impl Expr {
    pub fn new(raw: impl Into<String>) -> Self {
        Expr { kind: "expr", raw: raw.into() }
    }
}

/// Attr values are plain strings or (level 2+) braced expressions.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum AttrValue {
    Expr(Expr),
    Str(String),
}

/// Field values are typed literals or expressions (SPEC 4.1/9).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum FieldValue {
    Expr(Expr),
    Lit(Literal),
}

#[derive(Debug, Clone, Serialize)]
pub struct Prose {
    pub kind: &'static str,
    pub md: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlockNode {
    pub kind: &'static str,
    #[serde(rename = "type")]
    pub block_type: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub attrs: IndexMap<String, AttrValue>,
    pub fields: IndexMap<String, FieldValue>,
    pub body: Option<String>,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ForeignNode {
    pub kind: &'static str,
    pub foreign: bool,
    #[serde(rename = "type")]
    pub block_type: String,
    pub raw: String,
    pub line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<Diagnostic>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum Node {
    Prose(Prose),
    Block(BlockNode),
    Foreign(ForeignNode),
}

#[derive(Debug, Clone, Serialize)]
pub struct Doc {
    pub hdm: &'static str,
    pub nodes: Vec<Node>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
    pub line: u32,
}

/// Names visible to `{expr}` bindings while rendering (SPEC 5).
pub type Scope = indexmap::IndexMap<String, Literal>;

#[derive(Debug, Clone)]
pub struct ParseResult {
    pub doc: Doc,
    pub diagnostics: Vec<Diagnostic>,
}

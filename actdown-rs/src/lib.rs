//! actdown (HyperText Markdown): interactive markup for agents and humans
//! (SPEC draft 0.1).
//! Rust port of the TypeScript reference implementation; builds for
//! `wasm32-unknown-unknown` for embedding in agent runtimes.

pub mod canonical;
pub mod diag;
pub mod expr;
pub mod literal;
pub mod parse;
pub mod react;
pub mod render;
pub mod runtime;
pub mod types;

pub use canonical::{canonicalize, format, print, print_block, to_json};
pub use diag::ParseError;
pub use expr::{display, eval_expr, evaluate, parse_expr, ExprError};
pub use literal::{parse_field, print_literal};
pub use parse::parse;
pub use react::{compute_state, render_reactive, render_with_state};
pub use render::render;
pub use runtime::{hydrate, hydrate_with_initial, CapFn, CapResult, CapabilityRegistry, Runtime, RuntimeError};
pub use types::{AttrValue, BlockNode, Diagnostic, Doc, Expr, FieldValue, ForeignNode, Literal, Node, ParseResult, Prose, Scope};

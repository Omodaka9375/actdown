//! SPEC 6: the expression language. Small, total, typed; no functions, no
//! loops, no member assignment. `cap.send` is the only call form and is only
//! valid where a send sink is wired (in the reactive render there is none).
//! Faithful port of the TypeScript reference: same grammar, same budgets
//! (1000 steps / depth 64, SEC-4), same error codes.

use std::sync::OnceLock;

use regex::Regex;

use crate::literal::{js_stringify, js_num_to_string};
use crate::types::Literal;

pub const E_EXPR_PARSE: &str = "E_EXPR_PARSE";
pub const E_EXPR_STEP: &str = "E_EXPR_STEP";
pub const E_EXPR_DEPTH: &str = "E_EXPR_DEPTH";
pub const E_EXPR_EVAL: &str = "E_EXPR_EVAL";
pub const E_BIND_UNKNOWN: &str = "E_BIND_UNKNOWN";

#[derive(Debug, Clone)]
pub struct ExprError {
    pub code: &'static str,
    pub message: String,
}

impl ExprError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        ExprError { code, message: message.into() }
    }
}

impl std::fmt::Display for ExprError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ExprError {}

/// SEC-4 defaults: a render error, not a hang.
pub const DEFAULT_MAX_STEPS: u32 = 1000;
pub const DEFAULT_MAX_DEPTH: u32 = 64;

/// `$name` refers to event payload (SPEC 6); `send` implements `cap.send`.
pub struct EvalContext<'a> {
    pub scope: &'a crate::types::Scope,
    pub dollar: Option<&'a crate::types::Scope>,
    pub send: Option<&'a mut dyn FnMut(&str, Literal) -> Result<Literal, ExprError>>,
    pub max_steps: u32,
    pub max_depth: u32,
}

impl<'a> EvalContext<'a> {
    pub fn render(scope: &'a crate::types::Scope) -> Self {
        EvalContext { scope, dollar: None, send: None, max_steps: DEFAULT_MAX_STEPS, max_depth: DEFAULT_MAX_DEPTH }
    }
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum ExprAst {
    Num(f64),
    Str(String),
    Bool(bool),
    Null,
    Name(String),
    Dollar(String),
    Arr(Vec<ExprAst>),
    Obj(Vec<(String, ExprAst)>),
    Get(Box<ExprAst>, String),
    Idx(Box<ExprAst>, Box<ExprAst>),
    Call(Box<ExprAst>, Vec<ExprAst>),
    Un(char, Box<ExprAst>),
    Bin(String, Box<ExprAst>, Box<ExprAst>),
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Str(String),
    Name(String),
    Op(String),
}

const OPERATORS: [&str; 21] = [
    "<=", ">=", "==", "!=", "&&", "||", ".", "[", "]", "(", ")", "{", "}", ",", ":", "!", "-", "+", "<", ">", "$",
];

fn tokenize(src: &str) -> Result<Vec<Tok>, ExprError> {
    let b = src.as_bytes();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i] as char;
        if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
            i += 1;
            continue;
        }
        if c == '"' {
            let start = i;
            i += 1;
            let mut out = String::new();
            loop {
                if i >= b.len() {
                    return Err(ExprError::new(E_EXPR_PARSE, "unterminated string"));
                }
                let ch = src[i..].chars().next().unwrap();
                if ch == '"' {
                    i += 1;
                    break;
                }
                if ch == '\\' {
                    i += 1;
                    if i >= b.len() {
                        return Err(ExprError::new(E_EXPR_PARSE, "unterminated escape"));
                    }
                    let e = src[i..].chars().next().unwrap();
                    if e == 'u' {
                        let hex = src.get(i + 1..i + 5).ok_or_else(|| ExprError::new(E_EXPR_PARSE, "bad unicode escape"))?;
                        if !hex.chars().all(|h| h.is_ascii_hexdigit()) {
                            return Err(ExprError::new(E_EXPR_PARSE, "bad unicode escape"));
                        }
                        let cp = u32::from_str_radix(hex, 16).unwrap_or(0);
                        out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                        i += 5;
                    } else {
                        out.push(match e {
                            'n' => '\n',
                            't' => '\t',
                            'r' => '\r',
                            'b' => '\u{8}',
                            'f' => '\u{c}',
                            other => other,
                        });
                        i += e.len_utf8();
                    }
                    continue;
                }
                out.push(ch);
                i += ch.len_utf8();
            }
            toks.push(Tok::Str(out));
            let _ = start;
            continue;
        }
        if c.is_ascii_digit() || (c == '.' && src[i + 1..].chars().next().map_or(false, |n| n.is_ascii_digit())) {
            let num_re = num_re();
            let m = num_re.find(&src[i..]).ok_or_else(|| ExprError::new(E_EXPR_PARSE, "bad number"))?;
            let v: f64 = m.as_str().parse().map_err(|_| ExprError::new(E_EXPR_PARSE, "bad number"))?;
            toks.push(Tok::Num(v));
            i += m.as_str().len();
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            let name_re = name_re();
            let m = name_re.find(&src[i..]).unwrap();
            toks.push(Tok::Name(m.as_str().to_string()));
            i += m.as_str().len();
            continue;
        }
        let op = OPERATORS.iter().find(|o| src[i..].starts_with(*o));
        match op {
            Some(o) => {
                toks.push(Tok::Op(o.to_string()));
                i += o.len();
            }
            None => {
                return Err(ExprError::new(E_EXPR_PARSE, format!("unexpected character {:?}", c)));
            }
        }
    }
    Ok(toks)
}

/// `^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?`
fn num_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?").unwrap())
}

/// `^[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z_][A-Za-z0-9_]*)*` — a trailing `-` only
/// joins when followed by a letter, so `count-1` still parses as subtraction.
fn name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z_][A-Za-z0-9_]*)*").unwrap())
}

// ---------------------------------------------------------------------------
// Parser (SPEC 6 EBNF)
// ---------------------------------------------------------------------------

struct Parser {
    toks: Vec<Tok>,
    i: usize,
    depth: usize,
}

impl Parser {
    /// SEC-4: bound parser recursion too (E_EXPR_DEPTH), like the evaluator.
    fn enter(&mut self) -> Result<(), ExprError> {
        self.depth += 1;
        if self.depth > 64 {
            self.depth -= 1;
            return Err(ExprError::new(E_EXPR_DEPTH, "expression nesting too deep"));
        }
        Ok(())
    }

    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.i)
    }

    fn next(&mut self) -> Result<Tok, ExprError> {
        let t = self.toks.get(self.i).cloned();
        match t {
            None => Err(ExprError::new(E_EXPR_PARSE, "unexpected end of expression")),
            Some(t) => {
                self.i += 1;
                Ok(t)
            }
        }
    }

    fn expect_op(&mut self, v: &str) -> Result<(), ExprError> {
        let t = self.next()?;
        match t {
            Tok::Op(op) if op == v => Ok(()),
            other => Err(ExprError::new(E_EXPR_PARSE, format!("expected {}, got {:?}", v, other))),
        }
    }

    fn at_op(&self, v: &str) -> bool {
        matches!(self.peek(), Some(Tok::Op(op)) if op == v)
    }

    fn parse(&mut self) -> Result<ExprAst, ExprError> {
        let e = self.or()?;
        if self.peek().is_some() {
            return Err(ExprError::new(E_EXPR_PARSE, "unexpected token after expression"));
        }
        Ok(e)
    }

    fn or(&mut self) -> Result<ExprAst, ExprError> {
        let mut left = self.and()?;
        while self.at_op("||") {
            self.next()?;
            let right = self.and()?;
            left = ExprAst::Bin("||".into(), Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn and(&mut self) -> Result<ExprAst, ExprError> {
        let mut left = self.cmp()?;
        while self.at_op("&&") {
            self.next()?;
            let right = self.cmp()?;
            left = ExprAst::Bin("&&".into(), Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn cmp(&mut self) -> Result<ExprAst, ExprError> {
        let left = self.sum()?;
        if let Some(Tok::Op(op)) = self.peek() {
            let op = op.clone();
            if ["==", "!=", "<", "<=", ">", ">="].contains(&op.as_str()) {
                self.next()?;
                let right = self.sum()?;
                return Ok(ExprAst::Bin(op, Box::new(left), Box::new(right)));
            }
        }
        Ok(left)
    }

    fn sum(&mut self) -> Result<ExprAst, ExprError> {
        let mut left = self.unary()?;
        loop {
            let op = match self.peek() {
                Some(Tok::Op(o)) if o == "+" || o == "-" => o.clone(),
                _ => break,
            };
            self.next()?;
            let right = self.unary()?;
            left = ExprAst::Bin(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn unary(&mut self) -> Result<ExprAst, ExprError> {
        if self.at_op("!") || self.at_op("-") {
            self.enter()?;
            let op = if self.at_op("!") { '!' } else { '-' };
            self.next()?;
            let operand = self.unary();
            self.depth -= 1;
            return Ok(ExprAst::Un(op, Box::new(operand?)));
        }
        self.postfix()
    }

    fn postfix(&mut self) -> Result<ExprAst, ExprError> {
        let mut e = self.primary()?;
        loop {
            if self.at_op(".") {
                self.next()?;
                let t = self.next()?;
                match t {
                    Tok::Name(name) => e = ExprAst::Get(Box::new(e), name),
                    other => return Err(ExprError::new(E_EXPR_PARSE, format!("expected property name after ., got {:?}", other))),
                }
                continue;
            }
            if self.at_op("[") {
                self.enter()?;
                self.next()?;
                let index = self.or();
                self.depth -= 1;
                let index = index?;
                self.expect_op("]")?;
                e = ExprAst::Idx(Box::new(e), Box::new(index));
                continue;
            }
            if self.at_op("(") {
                self.next()?;
                let mut args = Vec::new();
                if !self.at_op(")") {
                    loop {
                        args.push(self.or()?);
                        if self.at_op(",") {
                            self.next()?;
                            continue;
                        }
                        break;
                    }
                }
                self.expect_op(")")?;
                e = ExprAst::Call(Box::new(e), args);
                continue;
            }
            return Ok(e);
        }
    }

    fn arr_items(&mut self) -> Result<Vec<ExprAst>, ExprError> {
        let mut items = Vec::new();
        if !self.at_op("]") {
            loop {
                items.push(self.or()?);
                if self.at_op(",") {
                    self.next()?;
                    continue;
                }
                break;
            }
        }
        self.expect_op("]")?;
        Ok(items)
    }

    fn primary(&mut self) -> Result<ExprAst, ExprError> {
        let t = self.next()?;
        match t {
            Tok::Num(v) => Ok(ExprAst::Num(v)),
            Tok::Str(v) => Ok(ExprAst::Str(v)),
            Tok::Name(v) => match v.as_str() {
                "true" => Ok(ExprAst::Bool(true)),
                "false" => Ok(ExprAst::Bool(false)),
                "null" => Ok(ExprAst::Null),
                _ => Ok(ExprAst::Name(v)),
            },
            Tok::Op(op) => match op.as_str() {
                "(" => {
                    self.enter()?;
                    let e = self.or();
                    self.depth -= 1;
                    let e = e?;
                    self.expect_op(")")?;
                    Ok(e)
                }
                "{" => {
                    let mut entries = Vec::new();
                    if !self.at_op("}") {
                        loop {
                            let kt = self.next()?;
                            let key = match kt {
                                Tok::Name(n) => n,
                                Tok::Str(s) => s,
                                other => {
                                    return Err(ExprError::new(E_EXPR_PARSE, format!("expected object key, got {:?}", other)))
                                }
                            };
                            self.expect_op(":")?;
                            let value = self.or()?;
                            entries.push((key, value));
                            if self.at_op(",") {
                                self.next()?;
                                continue;
                            }
                            break;
                        }
                    }
                    self.expect_op("}")?;
                    Ok(ExprAst::Obj(entries))
                }
                "[" => {
                    self.enter()?;
                    let items = self.arr_items();
                    self.depth -= 1;
                    Ok(ExprAst::Arr(items?))
                }
                "$" => {
                    let n = self.next()?;
                    match n {
                        Tok::Name(name) => Ok(ExprAst::Dollar(name)),
                        other => Err(ExprError::new(E_EXPR_PARSE, format!("expected name after $, got {:?}", other))),
                    }
                }
                other => Err(ExprError::new(E_EXPR_PARSE, format!("unexpected {}", other))),
            },
        }
    }
}

/// Parse an expression string into an AST. Throws `E_EXPR_PARSE`.
pub fn parse_expr(raw: &str) -> Result<ExprAst, ExprError> {
    let mut p = Parser { toks: tokenize(raw)?, i: 0, depth: 0 };
    p.parse()
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

fn deep_equal(a: &Literal, b: &Literal) -> bool {
    match (a, b) {
        (Literal::Null, Literal::Null) => true,
        (Literal::Bool(x), Literal::Bool(y)) => x == y,
        (Literal::Num(x), Literal::Num(y)) => x == y,
        (Literal::Str(x), Literal::Str(y)) => x == y,
        (Literal::Arr(x), Literal::Arr(y)) => {
            x.len() == y.len() && x.iter().zip(y.iter()).all(|(u, v)| deep_equal(u, v))
        }
        (Literal::Obj(x), Literal::Obj(y)) => {
            x.len() == y.len()
                && x.iter().all(|(k, v)| y.get(k).map_or(false, |w| deep_equal(v, w)))
        }
        _ => false,
    }
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

fn check_num(v: f64) -> Result<f64, ExprError> {
    if !v.is_finite() {
        return Err(ExprError::new(E_EXPR_EVAL, "non-finite number in expression"));
    }
    Ok(v)
}

fn obj_get(obj: &Literal, key: &str) -> Result<Literal, ExprError> {
    match obj {
        Literal::Obj(entries) => Ok(entries.get(key).cloned().unwrap_or(Literal::Null)),
        _ => Err(ExprError::new(E_EXPR_EVAL, "property access on non-object")),
    }
}

/// Evaluate an expression against a scope (SEC-4 budgets; SPEC 6 semantics).
pub fn evaluate(ast: &ExprAst, ctx: &mut EvalContext) -> Result<Literal, ExprError> {
    struct Runner<'a, 'b> {
        ctx: &'a mut EvalContext<'b>,
        steps: u32,
    }

    impl<'a, 'b> Runner<'a, 'b> {
        fn run(&mut self, e: &ExprAst, depth: u32) -> Result<Literal, ExprError> {
            self.steps += 1;
            if self.steps > self.ctx.max_steps {
                return Err(ExprError::new(E_EXPR_STEP, "expression step budget exceeded"));
            }
            if depth > self.ctx.max_depth {
                return Err(ExprError::new(E_EXPR_DEPTH, "expression depth cap exceeded"));
            }
            match e {
                ExprAst::Num(v) => Ok(Literal::Num(check_num(*v)?)),
                ExprAst::Str(v) => Ok(Literal::Str(v.clone())),
                ExprAst::Bool(v) => Ok(Literal::Bool(*v)),
                ExprAst::Null => Ok(Literal::Null),
                ExprAst::Name(name) => self
                    .ctx
                    .scope
                    .get(name)
                    .cloned()
                    .ok_or_else(|| ExprError::new(E_BIND_UNKNOWN, format!("unknown binding \"{}\"", name))),
                ExprAst::Dollar(name) => match self.ctx.dollar {
                    Some(d) => d
                        .get(name)
                        .cloned()
                        .ok_or_else(|| ExprError::new(E_BIND_UNKNOWN, format!("unknown payload \"${}\"", name))),
                    None => Err(ExprError::new(E_BIND_UNKNOWN, format!("unknown payload \"${}\"", name))),
                },
                ExprAst::Arr(items) => {
                    let mut out = Vec::with_capacity(items.len());
                    for it in items {
                        out.push(self.run(it, depth + 1)?);
                    }
                    Ok(Literal::Arr(out))
                }
                ExprAst::Obj(entries) => {
                    let mut out = indexmap::IndexMap::new();
                    for (k, v) in entries {
                        out.insert(k.clone(), self.run(v, depth + 1)?);
                    }
                    Ok(Literal::Obj(out))
                }
                ExprAst::Get(obj, name) => {
                    let o = self.run(obj, depth + 1)?;
                    obj_get(&o, name)
                }
                ExprAst::Idx(obj, index) => {
                    let o = self.run(obj, depth + 1)?;
                    let idx = self.run(index, depth + 1)?;
                    match (o, idx) {
                        (Literal::Arr(items), Literal::Num(n)) if n.fract() == 0.0 => {
                            if n < 0.0 || n >= items.len() as f64 {
                                Ok(Literal::Null)
                            } else {
                                Ok(items[n as usize].clone())
                            }
                        }
                        (Literal::Arr(_), Literal::Num(_)) => {
                            Err(ExprError::new(E_EXPR_EVAL, "array index must be an integer"))
                        }
                        (Literal::Obj(entries), Literal::Str(k)) => {
                            Ok(entries.get(&k).cloned().unwrap_or(Literal::Null))
                        }
                        _ => Err(ExprError::new(E_EXPR_EVAL, "cannot index this value")),
                    }
                }
                ExprAst::Call(callee, args) => {
                    // SPEC 6: the only call form is cap.send(name, args),
                    // valid only where a send sink is wired (on: handlers).
                    if let ExprAst::Get(obj, name) = &**callee {
                        if let ExprAst::Name(n) = &**obj {
                            if n == "cap" && name == "send" {
                                if self.ctx.send.is_none() {
                                    return Err(ExprError::new(E_EXPR_EVAL, "cap.send outside an event handler"));
                                }
                                if args.len() != 2 {
                                    return Err(ExprError::new(E_EXPR_EVAL, "cap.send takes (name, args)"));
                                }
                                let cap_name = self.run(&args[0], depth + 1)?;
                                let cap_args = self.run(&args[1], depth + 1)?;
                                let name = match &cap_name {
                                    Literal::Str(s) => s.clone(),
                                    _ => return Err(ExprError::new(E_EXPR_EVAL, "capability name must be a string")),
                                };
                                let send = self.ctx.send.as_mut().unwrap();
                                // Capability errors (E_CAP_MISSING, ...) propagate, as in TS.
                                return send(&name, cap_args);
                            }
                        }
                    }
                    Err(ExprError::new(E_EXPR_EVAL, "unknown function"))
                }
                ExprAst::Un(op, operand) => {
                    let v = self.run(operand, depth + 1)?;
                    match op {
                        '!' => Ok(Literal::Bool(!truthy(&v))),
                        '-' => match v {
                            Literal::Num(n) => Ok(Literal::Num(check_num(-n)?)),
                            _ => Err(ExprError::new(E_EXPR_EVAL, "unary - on non-number")),
                        },
                        _ => Err(ExprError::new(E_EXPR_EVAL, "unknown unary op")),
                    }
                }
                ExprAst::Bin(op, left, right) => match op.as_str() {
                    "||" => {
                        let l = self.run(left, depth + 1)?;
                        if truthy(&l) {
                            Ok(l)
                        } else {
                            self.run(right, depth + 1)
                        }
                    }
                    "&&" => {
                        let l = self.run(left, depth + 1)?;
                        if truthy(&l) {
                            self.run(right, depth + 1)
                        } else {
                            Ok(l)
                        }
                    }
                    _ => {
                        let l = self.run(left, depth + 1)?;
                        let r = self.run(right, depth + 1)?;
                        match op.as_str() {
                            "==" => Ok(Literal::Bool(deep_equal(&l, &r))),
                            "!=" => Ok(Literal::Bool(!deep_equal(&l, &r))),
                            "<" | "<=" | ">" | ">=" => match (&l, &r) {
                                (Literal::Num(a), Literal::Num(b)) => {
                                    // Both operands are finite; a comparison needs no overflow check.
                                    Ok(Literal::Bool(match op.as_str() {
                                        "<" => a < b,
                                        "<=" => a <= b,
                                        ">" => a > b,
                                        _ => a >= b,
                                    }))
                                }
                                (Literal::Str(a), Literal::Str(b)) => Ok(Literal::Bool(match op.as_str() {
                                    "<" => a < b,
                                    "<=" => a <= b,
                                    ">" => a > b,
                                    _ => a >= b,
                                })),
                                _ => Ok(Literal::Bool(false)),
                            },
                            "+" => match (&l, &r) {
                                (Literal::Str(_), _) | (_, Literal::Str(_)) => {
                                    Ok(Literal::Str(format!("{}{}", display(&l), display(&r))))
                                }
                                (Literal::Num(a), Literal::Num(b)) => {
                                    Ok(Literal::Num(check_num(a + b)?))
                                }
                                _ => Err(ExprError::new(E_EXPR_EVAL, "cannot add these types")),
                            },
                            "-" => match (&l, &r) {
                                (Literal::Num(a), Literal::Num(b)) => Ok(Literal::Num(check_num(a - b)?)),
                                _ => Err(ExprError::new(E_EXPR_EVAL, "subtraction on non-numbers")),
                            },
                            _ => Err(ExprError::new(E_EXPR_EVAL, "unknown operator")),
                        }
                    }
                },
            }
        }
    }

    let mut runner = Runner { ctx, steps: 0 };
    runner.run(ast, 0)
}

/// Stringify a value for display in rendered output (SPEC 11).
pub fn display(v: &Literal) -> String {
    match v {
        Literal::Null => String::new(),
        Literal::Bool(true) => "true".into(),
        Literal::Bool(false) => "false".into(),
        Literal::Num(n) => {
            if n.is_finite() {
                js_num_to_string(*n)
            } else if n.is_nan() {
                "NaN".into()
            } else if *n > 0.0 {
                "Infinity".into()
            } else {
                "-Infinity".into()
            }
        }
        Literal::Str(s) => s.clone(),
        Literal::Arr(_) | Literal::Obj(_) => js_stringify(v),
    }
}

/// Parse and evaluate in one step.
pub fn eval_expr(raw: &str, ctx: &mut EvalContext) -> Result<Literal, ExprError> {
    evaluate(&parse_expr(raw)?, ctx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Scope;

    fn eval(src: &str, scope: &Scope) -> Result<Literal, ExprError> {
        eval_expr(src, &mut EvalContext::render(scope))
    }

    #[test]
    fn arithmetic_and_bindings() {
        let mut scope = Scope::new();
        scope.insert("count".into(), Literal::Num(2.0));
        scope.insert("price".into(), Literal::Num(5.0));
        assert_eq!(eval("count + price", &scope).unwrap(), Literal::Num(7.0));
        assert_eq!(eval("count > 1", &scope).unwrap(), Literal::Bool(true));
        assert_eq!(eval("\"x\" + 1", &scope).unwrap(), Literal::Str("x1".into()));
    }

    #[test]
    fn unknown_binding_errors() {
        let scope = Scope::new();
        let err = eval("missing", &scope).unwrap_err();
        assert_eq!(err.code, E_BIND_UNKNOWN);
    }

    #[test]
    fn cap_send_needs_a_sink() {
        let scope = Scope::new();
        let err = eval("cap.send(\"x\", {})", &scope).unwrap_err();
        assert_eq!(err.code, E_EXPR_EVAL);
    }

    #[test]
    fn step_budget_is_enforced() {
        let scope = Scope::new();
        // Balanced tree: 2^12 leaves -> 8k+ steps at depth ~12, so the STEP
        // budget trips, not the depth cap and not the stack.
        let mut src = "1+1".to_string();
        for _ in 0..11 {
            src = format!("({}+{})", src, src);
        }
        let err = eval(&src, &scope).unwrap_err();
        assert_eq!(err.code, E_EXPR_STEP);
    }

    #[test]
    fn depth_cap_is_enforced() {
        let scope = Scope::new();
        // Left-nested chain: depth grows linearly, trips the 64 cap first.
        let src = "1".to_string() + &"+1".repeat(2000);
        let err = eval(&src, &scope).unwrap_err();
        assert_eq!(err.code, E_EXPR_DEPTH);
    }

    #[test]
    fn non_ascii_strings_survive_the_tokenizer() {
        let scope = Scope::new();
        assert_eq!(eval("\"café\"", &scope).unwrap(), Literal::Str("café".into()));
        assert_eq!(eval("\"日本語\"", &scope).unwrap(), Literal::Str("日本語".into()));
    }

    #[test]
    fn cap_send_errors_propagate() {
        let scope = Scope::new();
        let mut sink = |_name: &str, _args: Literal| -> Result<Literal, ExprError> {
            Err(ExprError::new("E_CAP_MISSING", "capability not granted: x"))
        };
        let mut ctx = EvalContext { scope: &scope, dollar: None, send: Some(&mut sink), max_steps: 1000, max_depth: 64 };
        let err = evaluate(&parse_expr("cap.send(\"x\", 1)").unwrap(), &mut ctx).unwrap_err();
        assert_eq!(err.code, "E_CAP_MISSING");
    }

    #[test]
    fn large_finite_comparisons_do_not_overflow() {
        let scope = Scope::new();
        assert_eq!(eval("1e308 <= 1e308", &scope).unwrap(), Literal::Bool(true));
        assert!(eval("1e308 + 1e308", &scope).is_err());
    }

    #[test]
    fn parser_nesting_is_capped() {
        let deep = "(".repeat(5000) + "1" + &")".repeat(5000);
        assert_eq!(parse_expr(&deep).unwrap_err().code, E_EXPR_DEPTH);
        let deep_idx = "a".to_string() + &"[".repeat(5000) + "0" + &"]".repeat(5000);
        assert_eq!(parse_expr(&deep_idx).unwrap_err().code, E_EXPR_DEPTH);
    }
}

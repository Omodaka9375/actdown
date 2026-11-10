//! Level-1 HTML rendering (SPEC 11, Appendix A). Port of the TypeScript
//! renderer: `{expr}` bindings render from the optional scope env (empty
//! spans without one; hydration fills them in), prose goes through the
//! minimal markdown renderer, and every block type maps per Appendix A.

use std::sync::OnceLock;

use regex::Regex;

use crate::expr::{display, eval_expr};
use crate::literal::{js_stringify, js_stringify_fields, print_literal};
use crate::types::{AttrValue, BlockNode, Doc, FieldValue, Literal, Node, Scope};

/// Async phases per action id: "pending" | "success" | "failure" (SPEC 4/7).
pub type PhaseMap = indexmap::IndexMap<String, String>;

/// Render context: the binding scope (None = level-1 static render), the
/// async phase map (None = every phase region renders hidden), and the
/// granted capability registry (None = every named capability renders
/// enabled, SPEC 4.2).
#[derive(Clone, Copy, Default)]
pub struct RenderCtx<'a> {
    pub env: Option<&'a Scope>,
    pub phases: Option<&'a PhaseMap>,
    pub registry: Option<&'a crate::runtime::CapabilityRegistry>,
}

impl<'a> RenderCtx<'a> {
    pub fn env(scope: &'a Scope) -> Self {
        RenderCtx { env: Some(scope), phases: None, registry: None }
    }
}

pub fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn esc_attr(s: &str) -> String {
    esc(s).replace('"', "&quot;").replace('\'', "&#39;")
}

/// Inert link URLs only: http(s)/mailto/tel or relative. Script schemes become "#".
pub fn safe_url(u: &str) -> String {
    // Browsers strip tab/newline from URL attributes, so `jav\tascript:`
    // would pass the scheme check below and still become a live script URL.
    // Strip them before the scheme checks (matches the TS fix). Leading and
    // trailing C0 controls and spaces are stripped too: `\u0001javascript:`
    // must not sneak a scheme past the filter.
    let stripped: String = u.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let t: &str = stripped.trim_matches(|c: char| (c as u32) <= 0x20);
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:") || lower.starts_with("tel:") {
        return t.to_string();
    }
    let scheme_like = t.chars().next().map_or(false, |c| c.is_ascii_alphabetic())
        && t.split(':').next().map_or(false, |s| s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')) && t.contains(':'));
    if scheme_like {
        return "#".into();
    }
    t.to_string()
}

/// `attr(v)`: plain strings pass through; expressions render as `{raw}`.
fn attr_value(v: &AttrValue) -> String {
    match v {
        AttrValue::Str(s) => s.clone(),
        AttrValue::Expr(e) => format!("{{{}}}", e.raw),
    }
}

fn data_attrs(b: &BlockNode) -> String {
    match &b.role {
        None => format!("data-ad-id=\"{}\"", esc_attr(&b.id)),
        Some(role) => format!("data-ad-id=\"{}\" role=\"{}\"", esc_attr(&b.id), esc_attr(role)),
    }
}

fn bind_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(^|[^\\])\{([^{}]+)\}").unwrap())
}

/// SPEC 5/Appendix A: `{expr}` bindings become data-ad-bind spans. Without
/// an env (level-1 render) the span is empty; with one the current value is
/// rendered inside for hydration. A binding that fails to evaluate renders
/// as an empty span: a render error affects one node, never the document.
fn bind(s: &str, ctx: RenderCtx) -> String {
    let re = bind_re();
    let mut out = String::new();
    let mut rest = s;
    loop {
        match re.captures(rest) {
            None => {
                out.push_str(&esc(rest));
                return out;
            }
            Some(c) => {
                let whole = c.get(0).unwrap();
                out.push_str(&esc(&rest[..whole.start()]));
                out.push_str(&esc(c.get(1).unwrap().as_str()));
                let raw = c.get(2).unwrap().as_str().trim();
                let val = match ctx.env {
                    None => String::new(),
                    Some(scope) => eval_expr(raw, &mut crate::expr::EvalContext::render(scope))
                        .map(|v| display(&v))
                        .unwrap_or_default(),
                };
                out.push_str(&format!("<span data-ad-bind=\"{}\">{}</span>", esc_attr(raw), esc(&val)));
                rest = &rest[whole.end()..];
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Prose: a minimal CommonMark-subset renderer (headings, lists, fences,
// blockquotes, paragraphs, inline emphasis/code/links).
// ---------------------------------------------------------------------------

fn inline_code_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new("`([^`]+)`").unwrap())
}
fn strong_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\*\*([^*]+)\*\*").unwrap())
}
fn em_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\*([^*]+)\*").unwrap())
}
fn link_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[([^\]]+)\]\(([^)\s]+)\)").unwrap())
}

fn inline(s: &str, ctx: RenderCtx) -> String {
    let mut out = bind(s, ctx);
    out = inline_code_re().replace_all(&out, "<code>$1</code>").into_owned();
    out = strong_re().replace_all(&out, "<strong>$1</strong>").into_owned();
    out = em_re().replace_all(&out, "<em>$1</em>").into_owned();
    out = link_re()
        .replace_all(&out, |c: &regex::Captures| {
            format!("<a href=\"{}\">{}</a>", esc_attr(&safe_url(c.get(2).unwrap().as_str())), c.get(1).unwrap().as_str())
        })
        .into_owned();
    out
}

fn fence_md_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(`{3,}|~{3,})[ \t]*(\S*)").unwrap())
}
fn heading_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(#{1,6})[ \t]+(.*)$").unwrap())
}
fn ul_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[*+-][ \t]+(.*)$").unwrap())
}
fn ol_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\d+[.)][ \t]+(.*)$").unwrap())
}
fn quote_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^>[ \t]?(.*)$").unwrap())
}

/// One row of a GFM pipe table: strip the optional edge pipes, split, trim.
/// Pipe-aware: `\|` is an escaped literal pipe inside a cell (GFM), not a
/// delimiter (matches the TS fix).
fn split_row(s: &str) -> Vec<String> {
    let t = s.trim();
    let t = t.strip_prefix('|').unwrap_or(t);
    let t = t.strip_suffix('|').unwrap_or(t);
    let mut cells: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut chars = t.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' && chars.peek() == Some(&'|') {
            cur.push('|');
            chars.next();
        } else if c == '|' {
            cells.push(cur.trim().to_string());
            cur = String::new();
        } else {
            cur.push(c);
        }
    }
    cells.push(cur.trim().to_string());
    cells
}

/// A delimiter row: `|---|:---:|` style; every cell is `:?-+:?`.
fn is_delim_row(s: &str) -> bool {
    if !s.contains('|') {
        return false;
    }
    let cells = split_row(s);
    !cells.is_empty()
        && cells.iter().all(|c| {
            let b = c.as_bytes();
            match b.len() {
                0 => false,
                1 => b[0] == b'-',
                _ => {
                    (b[0] == b':' || b[0] == b'-')
                        && (b[b.len() - 1] == b':' || b[b.len() - 1] == b'-')
                        && b[1..b.len() - 1].iter().all(|&ch| ch == b'-')
                }
            }
        })
}

fn prose_table(header: Vec<String>, rows: &[Vec<String>], ctx: RenderCtx) -> String {
    let ths: Vec<String> = header.iter().map(|c| format!("<th>{}</th>", inline(c, ctx))).collect();
    let body: Vec<String> = rows
        .iter()
        .map(|r| {
            let tds: Vec<String> = r.iter().map(|c| format!("<td>{}</td>", inline(c, ctx))).collect();
            format!("<tr>{}</tr>", tds.join(""))
        })
        .collect();
    format!(
        "<table>\n<thead><tr>{}</tr></thead>\n<tbody>\n{}\n</tbody>\n</table>",
        ths.join(""),
        body.join("\n")
    )
}

pub fn render_markdown(md: &str, ctx: RenderCtx) -> String {
    let lines: Vec<&str> = md.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut para: Vec<&str> = Vec::new();
    let mut list: Option<(bool, Vec<&str>)> = None; // (ordered, items)
    let mut fence: Option<(String, char, usize, Vec<&str>)> = None; // (lang, marker char, marker len, lines)

    let fence_open_re = fence_md_re();
    fn flush_para(out: &mut Vec<String>, para: &mut Vec<&str>, ctx: RenderCtx) {
        if !para.is_empty() {
            let joined = para.iter().map(|p| inline(p, ctx)).collect::<Vec<_>>().join("<br>\n");
            out.push(format!("<p>{}</p>", joined));
            para.clear();
        }
    }
    fn flush_list(out: &mut Vec<String>, list: &mut Option<(bool, Vec<&str>)>, ctx: RenderCtx) {
        if let Some((ordered, items)) = list.take() {
            let tag = if ordered { "ol" } else { "ul" };
            let lis: Vec<String> = items.iter().map(|i| format!("<li>{}</li>", inline(i, ctx))).collect();
            out.push(format!("<{}>\n{}\n</{}>", tag, lis.join("\n"), tag));
        }
    }

    // Rows below this index were already consumed by a prose table; the
    // guard at the top of the loop skips them (the TS port advances its
    // index instead).
    let mut consumed_until = 0usize;
    for (i, ln_ref) in lines.iter().enumerate() {
        let ln: &str = ln_ref;
        if i < consumed_until {
            continue;
        }
        let cf = fence_open_re.captures(ln);
        if fence.is_none() {
            if let Some(c) = cf {
                flush_para(&mut out, &mut para, ctx);
                flush_list(&mut out, &mut list, ctx);
                fence = Some((c.get(2).map_or("", |g| g.as_str()).to_string(), c.get(1).unwrap().as_str().chars().next().unwrap_or('`'), c.get(1).unwrap().as_str().chars().count(), Vec::new()));
                continue;
            }
        } else {
            // CommonMark parity (matches the TS port): the closing fence must
            // be the same character and at least as long as the opening one.
            let closing = match cf {
                Some(c) => {
                    let marker = c.get(1).map(|m| m.as_str()).unwrap_or("");
                    let (ch, open_len) = (fence.1, fence.2);
                    marker.starts_with(ch)
                        && marker.chars().take_while(|&x| x == ch).count() >= open_len
                }
                None => false,
            };
            if closing {
                let (lang, _, _, content) = fence.take().unwrap();
                let class =
                    if lang.is_empty() { String::new() } else { format!(" class=\"language-{}\"", esc_attr(&lang)) };
                out.push(format!("<pre><code{}>{}</code></pre>", class, esc(&content.join("\n"))));
            } else {
                fence.as_mut().unwrap().3.push(ln);
            }
            continue;
        }
        // GFM pipe table: a row followed by a delimiter row; body rows
        // continue until a line without a pipe (blank or paragraph text ends
        // the table).
        if ln.contains('|') && i + 1 < lines.len() && is_delim_row(lines[i + 1]) {
            flush_para(&mut out, &mut para, ctx);
            flush_list(&mut out, &mut list, ctx);
            let mut rows: Vec<Vec<String>> = Vec::new();
            let mut j = i + 2;
            while j < lines.len() && !lines[j].trim().is_empty() && lines[j].contains('|') {
                rows.push(split_row(lines[j]));
                j += 1;
            }
            consumed_until = j;
            out.push(prose_table(split_row(ln), &rows, ctx));
            continue;
        }
        if let Some(h) = heading_re().captures(ln) {
            flush_para(&mut out, &mut para, ctx);
            flush_list(&mut out, &mut list, ctx);
            let n = h.get(1).unwrap().as_str().len();
            out.push(format!("<h{}>{}</h{}>", n, inline(h.get(2).unwrap().as_str(), ctx), n));
            continue;
        }
        if let Some(ul) = ul_re().captures(ln) {
            let item = ul.get(1).unwrap().as_str();
            let is_new = match &list {
                None => true,
                Some((ordered, _)) => *ordered,
            };
            flush_para(&mut out, &mut para, ctx);
            if is_new {
                flush_list(&mut out, &mut list, ctx);
                list = Some((false, vec![item]));
            } else {
                list.as_mut().unwrap().1.push(item);
            }
            continue;
        }
        if let Some(ol) = ol_re().captures(ln) {
            let item = ol.get(1).unwrap().as_str();
            let is_new = match &list {
                None => true,
                Some((ordered, _)) => !*ordered,
            };
            flush_para(&mut out, &mut para, ctx);
            if is_new {
                flush_list(&mut out, &mut list, ctx);
                list = Some((true, vec![item]));
            } else {
                list.as_mut().unwrap().1.push(item);
            }
            continue;
        }
        if let Some(q) = quote_re().captures(ln) {
            flush_para(&mut out, &mut para, ctx);
            flush_list(&mut out, &mut list, ctx);
            out.push(format!("<blockquote>{}</blockquote>", inline(q.get(1).unwrap().as_str(), ctx)));
            continue;
        }
        if ln.trim().is_empty() {
            flush_para(&mut out, &mut para, ctx);
            flush_list(&mut out, &mut list, ctx);
            continue;
        }
        flush_list(&mut out, &mut list, ctx);
        para.push(ln);
    }
    if let Some((_lang, content)) = fence {
        // Unterminated fence at EOF: no language class (matches the reference).
        out.push(format!("<pre><code>{}</code></pre>", esc(&content.join("\n"))));
    }
    flush_para(&mut out, &mut para, ctx);
    flush_list(&mut out, &mut list, ctx);
    out.join("\n")
}

// ---------------------------------------------------------------------------
// Blocks (Appendix A)
// ---------------------------------------------------------------------------

fn parse_opts(s: &str) -> Vec<(String, String)> {
    let mut map = Vec::new();
    if s.trim().is_empty() {
        return map;
    }
    // Split on top-level commas only: brackets and quotes may nest commas
    // (options=["a", "b"], pattern="[0-9]{2},[a-z]{2}").
    let push = |map: &mut Vec<(String, String)>, part: &str| match part.find('=') {
        None => map.push((part.trim().to_string(), String::new())),
        Some(eq) => map.push((part[..eq].trim().to_string(), part[eq + 1..].trim().to_string())),
    };
    let mut depth = 0usize;
    let mut in_str = false;
    let mut start = 0usize;
    for (i, &b) in s.as_bytes().iter().enumerate() {
        if in_str {
            if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'[' | b'{' | b'(' => depth += 1,
            b']' | b'}' | b')' => depth = depth.saturating_sub(1),
            b',' if depth == 0 => {
                push(&mut map, &s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    push(&mut map, &s[start..]);
    map
}

/// `JSON.parse` with validation: must be an array; items are stringified
/// (the reference maps them through String()).
fn safe_json_array(s: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(s) else { return Vec::new() };
    match v {
        serde_json::Value::Array(items) => items
            .into_iter()
            .map(|i| match i {
                serde_json::Value::String(s) => s,
                // JS String() coercion (the reference maps items through String()).
                serde_json::Value::Null => "null".into(),
                serde_json::Value::Bool(b) => b.to_string(),
                serde_json::Value::Number(n) => crate::literal::js_num_to_string(n.as_f64().unwrap_or(f64::NAN)),
                serde_json::Value::Array(a) => a
                    .iter()
                    .map(|x| match x {
                        serde_json::Value::String(s) => s.clone(),
                        serde_json::Value::Null => String::new(),
                        other => other.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join(","),
                serde_json::Value::Object(_) => "[object Object]".into(),
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn control_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^([a-z]+)\((.*)\)$").unwrap())
}

fn render_controls(b: &BlockNode) -> String {
    let fid = esc_attr(&b.id);
    let mut out: Vec<String> = Vec::new();
    for (name, v) in &b.fields {
        let raw = match v {
            FieldValue::Lit(Literal::Str(s)) => s.clone(),
            _ => continue,
        };
        let parsed = control_re().captures(&raw);
        let (kind, opts_str) = match &parsed {
            Some(m) => (m.get(1).unwrap().as_str().to_string(), m.get(2).unwrap().as_str().to_string()),
            None => (raw.trim().to_string(), String::new()),
        };
        let opts = parse_opts(&opts_str);
        let id = format!("{}.{}", fid, esc_attr(name));
        let req = if opts.iter().any(|(k, _)| k == "required") { " required" } else { "" };
        let opt = |k: &str| opts.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
        // One optional HTML attribute from the control opts; "" when absent.
        let attr_opt = |opts: &[(String, String)], name: &str| -> String {
            match opts.iter().find(|(k, _)| k == name) {
                Some((_, raw)) if !raw.is_empty() => {
                    let v = raw.strip_prefix('"').and_then(|s| s.strip_suffix('"')).unwrap_or(raw);
                    format!(" {}=\"{}\"", name, esc_attr(v))
                }
                _ => String::new(),
            }
        };
        match kind.as_str() {
            "input" => {
                let ty = match opt("type") {
                    Some(t) => t,
                    None => match &parsed {
                        None => "text".to_string(),
                        Some(m) => {
                            let first =
                                m.get(2).unwrap().as_str().split(',').next().unwrap_or("").trim();
                            if first.is_empty() { "text".to_string() } else { first.to_string() }
                        }
                    },
                };
                // SPEC 4.3 validation opts: min, max, pattern, maxlength; value
                // seeds the initial content. Attribute order is fixed (byte-exact ports).
                let extra = format!(
                    "{}{}{}{}{}",
                    attr_opt(&opts, "min"),
                    attr_opt(&opts, "max"),
                    attr_opt(&opts, "pattern"),
                    attr_opt(&opts, "maxlength"),
                    attr_opt(&opts, "value"),
                );
                out.push(format!(
                    "<input type=\"{}\" name=\"{}\" id=\"{}\"{}{}>",
                    esc_attr(&ty),
                    esc_attr(name),
                    id,
                    req,
                    extra
                ));
            }
            "textarea" => {
                let value = match opt("value") {
                    Some(v) => {
                        if v.starts_with('"') && v.ends_with('"') && v.len() >= 2 {
                            v[1..v.len() - 1].to_string()
                        } else {
                            v
                        }
                    }
                    None => String::new(),
                };
                out.push(format!(
                    "<textarea name=\"{}\" id=\"{}\"{}{}>{}</textarea>",
                    esc_attr(name),
                    id,
                    req,
                    attr_opt(&opts, "maxlength"),
                    esc(&value)
                ));
            }
            "select" => {
                let raw = opt("options").unwrap_or_else(|| "[]".to_string());
                let items = safe_json_array(&raw);
                let body: Vec<String> =
                    items.iter().map(|o| format!("<option>{}</option>", esc(o))).collect();
                out.push(format!(
                    "<select name=\"{}\" id=\"{}\"{}>{}</select>",
                    esc_attr(name),
                    id,
                    req,
                    body.join("")
                ));
            }
            "checkbox" => {
                out.push(format!("<input type=\"checkbox\" name=\"{}\" id=\"{}\">", esc_attr(name), id));
            }
            "submit" => {
                let label = opt("label").unwrap_or_else(|| "Submit".to_string());
                let label = if label.starts_with('"') && label.ends_with('"') && label.len() >= 2 {
                    label[1..label.len() - 1].to_string()
                } else {
                    label
                };
                out.push(format!("<button type=\"submit\" id=\"{}\">{}</button>", id, esc(&label)));
            }
            _ => {}
        }
    }
    out.join("\n")
}

fn render_action(b: &BlockNode, ctx: RenderCtx) -> String {
    let label = bind(b.body.as_deref().unwrap_or(""), ctx);
    // SPEC 4.2: an action whose capability is not registered renders
    // disabled with data-cap-missing (parity with the TS port).
    let cap = b.attrs.get("name").map(|v| attr_value_plain(v)).unwrap_or_default();
    let known = cap.is_empty() || ctx.registry.map_or(true, |r| r.has(&cap));
    let missing = if known { String::new() } else { " data-cap-missing".to_string() };
    let disabled = if known { String::new() } else { " disabled".to_string() };
    if let Some(href) = b.attrs.get("href") {
        return format!("<a href=\"{}\" {}{}>{}</a>", esc_attr(&safe_url(&attr_value(href))), data_attrs(b), missing, label);
    }
    format!("<button {}{}{}>{}</button>", data_attrs(b), missing, disabled, label)
}

/// An attr value as its plain string form (expressions keep their raw text).
fn attr_value_plain(v: &AttrValue) -> String {
    match v {
        AttrValue::Str(s) => s.clone(),
        AttrValue::Expr(e) => format!("{{{}}}", e.raw),
    }
}

fn table_sep_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\|?[ \t]*:?-{2,}").unwrap())
}

fn render_table(b: &BlockNode, ctx: RenderCtx) -> String {
    let sep_re = table_sep_re();
    let mut rows: Vec<Vec<String>> = Vec::new();
    for ln in b.body.as_deref().unwrap_or("").split('\n') {
        let t = ln.trim();
        if t.is_empty() || sep_re.is_match(t) {
            continue;
        }
        let stripped = t.strip_prefix('|').unwrap_or(t);
        let stripped = stripped.strip_suffix('|').unwrap_or(stripped);
        let cells: Vec<String> = stripped.split('|').map(|c| c.trim().to_string()).collect();
        rows.push(cells);
    }
    if rows.is_empty() {
        return format!("<table {}></table>", data_attrs(b));
    }
    let head = &rows[0];
    let head_cells: Vec<String> = head.iter().map(|c| format!("<th>{}</th>", inline(c, ctx))).collect();
    let body_rows: Vec<String> = rows[1..]
        .iter()
        .map(|r| {
            let cells: Vec<String> = r.iter().map(|c| format!("<td>{}</td>", inline(c, ctx))).collect();
            format!("<tr>{}</tr>", cells.join(""))
        })
        .collect();
    format!(
        "<table {}>\n<thead><tr>{}</tr></thead>\n<tbody>\n{}\n</tbody>\n</table>",
        data_attrs(b),
        head_cells.join(""),
        body_rows.join("\n")
    )
}

/// One cell of a chart fallback table: literals render via display(),
/// expressions evaluate in the binding scope (empty like any binding when
/// there is no env) and never throw past one cell.
fn chart_cell(v: &FieldValue, ctx: RenderCtx) -> String {
    match v {
        FieldValue::Expr(e) => match ctx.env {
            None => String::new(),
            Some(scope) => {
                let rendered = eval_expr(&e.raw, &mut crate::expr::EvalContext::render(scope))
                    .map(|v| display(&v))
                    .unwrap_or_default();
                inline(&rendered, ctx)
            }
        },
        FieldValue::Lit(l) => inline(&display(l), ctx),
    }
}

/// SPEC Appendix A: an ad-chart renders `<figure data-ad-chart="type">` with a
/// `<table>` fallback of the data. Accepted shapes for the `data` field:
/// array of arrays (rows; `columns` field names them), array of objects
/// (first-seen key order is the header), or a flat array of scalars (one
/// column). Mixed or empty shapes render no table: the figure stays empty and
/// the AST is still the contract.
fn chart_table(data: Option<&FieldValue>, columns: Option<&FieldValue>, ctx: RenderCtx) -> String {
    let Some(FieldValue::Lit(Literal::Arr(arr))) = data else { return String::new() };
    if arr.is_empty() {
        return String::new();
    }
    let header: Option<Vec<String>>;
    let rows: Vec<Vec<String>>;
    if arr.iter().all(|r| matches!(r, Literal::Arr(_))) {
        rows = arr
            .iter()
            .map(|r| match r {
                Literal::Arr(cells) => cells.iter().map(|c| chart_cell(&FieldValue::Lit(c.clone()), ctx)).collect(),
                _ => unreachable!(),
            })
            .collect();
        header = match columns {
            Some(FieldValue::Lit(Literal::Arr(cols))) if cols.iter().all(|c| matches!(c, Literal::Str(_))) => {
                Some(cols.iter().map(|c| match c { Literal::Str(s) => s.clone(), _ => unreachable!() }).collect())
            }
            _ => None,
        };
    } else if arr.iter().all(|r| matches!(r, Literal::Obj(_))) {
        let mut keys: Vec<String> = Vec::new();
        for r in arr {
            if let Literal::Obj(m) = r {
                for k in m.keys() {
                    if !keys.contains(k) {
                        keys.push(k.clone());
                    }
                }
            }
        }
        rows = arr
            .iter()
            .map(|r| {
                let empty = Literal::Null;
                match r {
                    Literal::Obj(m) => keys
                        .iter()
                        .map(|k| chart_cell(&FieldValue::Lit(m.get(k).unwrap_or(&empty).clone()), ctx))
                        .collect(),
                    _ => unreachable!(),
                }
            })
            .collect();
        header = Some(keys);
    } else if arr.iter().all(|r| matches!(r, Literal::Null | Literal::Bool(_) | Literal::Num(_) | Literal::Str(_))) {
        rows = arr.iter().map(|v| vec![chart_cell(&FieldValue::Lit(v.clone()), ctx)]).collect();
        header = None;
    } else {
        return String::new(); // mixed shapes: no deterministic fallback
    }
    let tbody_rows: Vec<String> = rows
        .iter()
        .map(|r| format!("<tr>{}</tr>", r.iter().map(|c| format!("<td>{}</td>", c)).collect::<String>()))
        .collect();
    let tbody = format!("<tbody>\n{}\n</tbody>", tbody_rows.join("\n"));
    match header {
        None => format!("<table>\n{}\n</table>", tbody),
        Some(h) => {
            let ths: String = h.iter().map(|c| format!("<th>{}</th>", inline(c, ctx))).collect();
            format!("<table>\n<thead><tr>{}</tr></thead>\n{}\n</table>", ths, tbody)
        }
    }
}

fn render_chart(b: &BlockNode, ctx: RenderCtx) -> String {
    let ty = match b.fields.get("type") {
        Some(v) => esc_attr(&print_literal(v)),
        None => String::new(),
    };
    let table = chart_table(b.fields.get("data"), b.fields.get("columns"), ctx);
    if table.is_empty() {
        format!("<figure {} data-ad-chart=\"{}\"></figure>", data_attrs(b), ty)
    } else {
        format!("<figure {} data-ad-chart=\"{}\">\n{}\n</figure>", data_attrs(b), ty, table)
    }
}

/// ad-list (SPEC 3 level 1): an `items` field (array of literals) or body
/// lines (markdown list markers stripped) render as `<ul>`/`<ol>`. Ordered
/// when every body line uses `N.` / `N)` markers, or via `ordered: true`.
fn render_list_block(b: &BlockNode, ctx: RenderCtx) -> String {
    let mut items: Vec<String> = Vec::new();
    let mut ordered = matches!(b.fields.get("ordered"), Some(FieldValue::Lit(Literal::Bool(true))));
    match b.fields.get("items") {
        Some(FieldValue::Lit(Literal::Arr(vs))) => {
            items = vs.iter().map(|v| chart_cell(&FieldValue::Lit(v.clone()), ctx)).collect();
        }
        _ => {
            if let Some(body) = b.body.as_deref() {
                if !body.trim().is_empty() {
                    let ul_re = regex::Regex::new(r"^[*+-][ \t]+").unwrap();
                    let ol_re = regex::Regex::new(r"^\d+[.)][ \t]+").unwrap();
                    let mut all_ol = true;
                    let lines: Vec<&str> = body.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
                    if lines.is_empty() {
                        all_ol = false;
                    }
                    for l in &lines {
                        if ol_re.is_match(l) {
                            items.push(ol_re.replace(l, "").into_owned());
                        } else {
                            all_ol = false;
                            if ul_re.is_match(l) {
                                items.push(ul_re.replace(l, "").into_owned());
                            } else {
                                items.push((*l).to_string());
                            }
                        }
                    }
                    if !lines.is_empty() {
                        ordered = all_ol;
                    }
                }
            }
        }
    }
    let tag = if ordered { "ol" } else { "ul" };
    if items.is_empty() {
        return format!("<{} {}></{}>", tag, data_attrs(b), tag);
    }
    let lis: Vec<String> = items.iter().map(|i| format!("<li>{}</li>", i)).collect();
    format!("<{} {}>\n{}\n</{}>", tag, data_attrs(b), lis.join("\n"), tag)
}

fn render_data_block(b: &BlockNode) -> String {
    let json = js_stringify_fields(&b.fields);
    // Inside a raw-text <script> the HTML parser does not decode entities,
    // so esc() would corrupt published values. JSON-escape instead (matches
    // the TS fix): \u00XX keeps JSON.parse correct while staying HTML-inert.
    let inert = json
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!("<script type=\"application/x-ad-data\" {}>{}</script>", data_attrs(b), inert)
}

/// Display a field's value (SPEC 11): a quoted string shows its actual
/// content, not its source serialization; printLiteral is for canonical
/// text only (matches the TS displayLiteral fix).
fn display_field(v: &FieldValue) -> String {
    match v {
        FieldValue::Lit(Literal::Str(s)) => s.clone(),
        other => print_literal(other),
    }
}

fn field_str(b: &BlockNode, key: &str) -> Option<String> {
    b.fields.get(key).map(display_field)
}

fn render_block(b: &BlockNode, ctx: RenderCtx) -> String {
    match b.block_type.as_str() {
        "state" | "data" => render_data_block(b),
        "text" => bind(b.fields.get("body").map(print_literal).unwrap_or_default().as_str(), ctx),
        "action" => render_action(b, ctx),
        "form" => format!("<form {}>\n{}\n</form>", data_attrs(b), render_controls(b)),
        "image" => {
            let dim = |k: &str| match b.fields.get(k) {
                Some(FieldValue::Lit(Literal::Num(n))) => {
                    format!(" {}=\"{}\"", k, js_stringify(&Literal::Num(*n)))
                }
                _ => String::new(),
            };
            let src = safe_url(&field_str(b, "src").unwrap_or_default());
            let alt = field_str(b, "alt").unwrap_or_default();
            format!(
                "<img src=\"{}\" alt=\"{}\"{}{}>",
                esc_attr(&src),
                esc_attr(&alt),
                dim("width"),
                dim("height")
            )
        }
        "link" => {
            let href = safe_url(&field_str(b, "href").unwrap_or_default());
            format!(
                "<a href=\"{}\" {}>{}</a>",
                esc_attr(&href),
                data_attrs(b),
                bind(b.body.as_deref().unwrap_or(""), ctx)
            )
        }
        "table" => render_table(b, ctx),
        "chart" => render_chart(b, ctx),
        "list" => render_list_block(b, ctx),
        _ => {
            let json = js_stringify_fields(&b.fields);
            let async_attrs = match b.fields.get("phase") {
                Some(FieldValue::Lit(Literal::Str(phase))) => {
                    let for_id = match b.fields.get("for") {
                        Some(FieldValue::Lit(Literal::Str(s))) => s.clone(),
                        _ => String::new(),
                    };
                    // Without a phase map every region renders hidden (the
                    // static/complete-without-JS contract, SPEC 11).
                    let active = ctx.phases.map_or(false, |p| p.get(&for_id) == Some(phase));
                    if active {
                        format!(
                            " data-ad-for=\"{}\" data-ad-phase=\"{}\"",
                            esc_attr(&for_id),
                            esc_attr(phase)
                        )
                    } else {
                        format!(
                            " data-ad-for=\"{}\" data-ad-phase=\"{}\" hidden",
                            esc_attr(&for_id),
                            esc_attr(phase)
                        )
                    }
                }
                _ => String::new(),
            };
            format!(
                "<section data-ad-type=\"{}\" {}{} data-ad-fields=\"{}\">{}</section>",
                esc_attr(&b.block_type),
                data_attrs(b),
                async_attrs,
                esc_attr(&json),
                bind(b.body.as_deref().unwrap_or(""), ctx)
            )
        }
    }
}

/// Render one node with a render context (SPEC 5/11).
pub fn render_node(n: &Node, ctx: RenderCtx) -> String {
    match n {
        Node::Prose(p) => render_markdown(&p.md, ctx),
        Node::Foreign(f) => format!("<pre><code>{}</code></pre>", esc(&f.raw)),
        Node::Block(b) => render_block(b, ctx),
    }
}

/// Render a document to level-1 HTML (SPEC 11, Appendix A).
pub fn render(doc: &Doc) -> String {
    doc.nodes.iter().map(|n| render_node(n, RenderCtx::default())).collect::<Vec<_>>().join("\n")
}

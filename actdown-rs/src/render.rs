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

/// Render context: the binding scope (None = level-1 static render) and the
/// async phase map (None = every phase region renders hidden).
#[derive(Clone, Copy, Default)]
pub struct RenderCtx<'a> {
    pub env: Option<&'a Scope>,
    pub phases: Option<&'a PhaseMap>,
}

impl<'a> RenderCtx<'a> {
    pub fn env(scope: &'a Scope) -> Self {
        RenderCtx { env: Some(scope), phases: None }
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
    let t = u.trim();
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

pub fn render_markdown(md: &str, ctx: RenderCtx) -> String {
    let lines: Vec<&str> = md.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut para: Vec<&str> = Vec::new();
    let mut list: Option<(bool, Vec<&str>)> = None; // (ordered, items)
    let mut fence: Option<(String, Vec<&str>)> = None; // (lang, lines)

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

    for ln in &lines {
        let cf = fence_open_re.captures(ln);
        if fence.is_none() {
            if let Some(c) = cf {
                flush_para(&mut out, &mut para, ctx);
                flush_list(&mut out, &mut list, ctx);
                fence = Some((c.get(2).map_or("", |g| g.as_str()).to_string(), Vec::new()));
                continue;
            }
        } else {
            // Reference quirk kept: when the fence has a language, ANY fence
            // line closes it; without one only backtick fences close.
            let closing = match (cf, fence.as_ref()) {
                (Some(c), Some((lang, _))) => {
                    let marker = c.get(1).unwrap().as_str();
                    if lang.is_empty() { marker.starts_with('`') } else { true }
                }
                _ => false,
            };
            if closing {
                let (lang, content) = fence.take().unwrap();
                let class =
                    if lang.is_empty() { String::new() } else { format!(" class=\"language-{}\"", esc_attr(&lang)) };
                out.push(format!("<pre><code{}>{}</code></pre>", class, esc(&content.join("\n"))));
            } else {
                fence.as_mut().unwrap().1.push(ln);
            }
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
    for part in s.split(',') {
        match part.find('=') {
            None => map.push((part.trim().to_string(), String::new())),
            Some(eq) => map.push((part[..eq].trim().to_string(), part[eq + 1..].trim().to_string())),
        }
    }
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
                out.push(format!(
                    "<input type=\"{}\" name=\"{}\" id=\"{}\"{}>",
                    esc_attr(&ty),
                    esc_attr(name),
                    id,
                    req
                ));
            }
            "textarea" => {
                out.push(format!("<textarea name=\"{}\" id=\"{}\"{}></textarea>", esc_attr(name), id, req));
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
    if let Some(href) = b.attrs.get("href") {
        return format!("<a href=\"{}\" {}>{}</a>", esc_attr(&safe_url(&attr_value(href))), data_attrs(b), label);
    }
    format!("<button {}>{}</button>", data_attrs(b), label)
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

fn render_chart(b: &BlockNode) -> String {
    let ty = match b.fields.get("type") {
        Some(v) => esc_attr(&print_literal(v)),
        None => String::new(),
    };
    format!("<figure {} data-ad-chart=\"{}\"></figure>", data_attrs(b), ty)
}

fn render_data_block(b: &BlockNode) -> String {
    let json = js_stringify_fields(&b.fields);
    format!("<script type=\"application/x-ad-data\" {}>{}</script>", data_attrs(b), esc(&json))
}

fn field_str(b: &BlockNode, key: &str) -> Option<String> {
    b.fields.get(key).map(print_literal)
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
        "chart" => render_chart(b),
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

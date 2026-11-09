import { describe, expect, it } from "vitest";
import { format, html2hdm, htmlToDoc, parse } from "../src/index.js";

describe("html2hdm (SPEC 12)", () => {
  it("collapses presentational markup into prose (DOW-1)", () => {
    const hdm = html2hdm('<div class="wrapper"><p>Hello <b>world</b></p><span>.</span></div>');
    const { doc } = parse(hdm);
    expect(doc.nodes).toEqual([{ kind: "prose", md: "Hello **world**\n\n." }]);
  });

  it("maps headings, lists, blockquotes and code", () => {
    const hdm = html2hdm(
      "<h2>Plan</h2><ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>" +
      "<pre><code class=\"language-js\">x();</code></pre>",
    );
    expect(hdm).toContain("## Plan");
    expect(hdm).toContain("- one\n- two\n  - nested");
    expect(hdm).toContain("```js\nx();\n```");
  });

  it("drops script and style (DOW-2)", () => {
    const { doc } = htmlToDoc("<p>keep</p><script>evil()</script><style>.a{}</style>");
    expect(JSON.stringify(doc)).not.toContain("evil");
    expect(JSON.stringify(doc)).not.toContain(".a{}");
  });

  it("records non-trivial event handlers as x-legacy-handler (DOW-2)", () => {
    const hdm = html2hdm('<button onclick="cart.add(1)">Buy</button>');
    expect(hdm).toContain("name=x-legacy:button");
    expect(hdm).toContain("x-legacy-handler=cart.add(1)");
  });

  it("converts tables to hdm-table blocks (DOW-1)", () => {
    const hdm = html2hdm("<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>");
    expect(hdm).toContain("```hdm-table");
    expect(hdm).toContain("| a | b |");
    expect(hdm).toContain("| 1 | 2 |");
  });

  it("converts images and links with roles", () => {
    const hdm = html2hdm('<img src="a.png" alt="A" width="320"><a href="/docs" id="docs-link">Docs</a>');
    expect(hdm).toContain("```hdm-image");
    expect(hdm).toContain("src: a.png");
    expect(hdm).toContain("role: image");
    expect(hdm).toContain("```hdm-link");
    expect(hdm).toContain("href: /docs");
  });

  it("converts forms to hdm-form with x-legacy action (DOW-4)", () => {
    const hdm = html2hdm(
      '<form id="contact" action="/send" onsubmit="validate()">' +
      '<input type="email" name="email" required><textarea name="message" maxlength="500"></textarea>' +
      '<select name="topic"><option value="bug">Bug</option><option>Billing</option></select>' +
      '<input type="checkbox" name="urgent">' +
      '<button type="submit">Send it</button></form>',
      { source: "/legacy/contact.html" },
    );
    expect(hdm).toContain("```hdm-form?action=x-legacy%3A%2Flegacy%2Fcontact.html%23contact&x-legacy-handler=validate()");
    expect(hdm).toContain("role: form");
    expect(hdm).toContain('email: "input(email, required)"');
    expect(hdm).toContain("message: textarea(maxlength=500)");
    expect(hdm).toContain('topic: "select(options=[\\"bug\\",\\"Billing\\"])"');
    expect(hdm).toContain("urgent: checkbox");
    expect(hdm).toContain('send-it: "submit(label=\\"Send it\\")"');
  });

  it("output is canonical: format(html2hdm(x)) is a fixpoint (DOW-3)", () => {
    const hdm = html2hdm("<h1>T</h1><p>text</p><button>Go</button>");
    expect(hdm).toContain("# T");
    expect(hdm).toContain("```hdm-action");
    expect(hdm).toContain("role: button");
    // The converter output is already canonical text (INV-3 via format).
    expect(format(hdm)).toBe(hdm);
  });
});

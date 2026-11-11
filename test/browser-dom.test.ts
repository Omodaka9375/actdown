import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

/**
 * Real-browser tests for the DOM adapter (SPEC 11). The fake-element unit
 * tests in test/dom.test.ts cover the logic; these run hydrateDom in a real
 * Chrome/Edge over CDP, exercising genuine HTMLElement semantics the fakes
 * cannot: real `hidden` reflection, real `closest()` for each= clone
 * scoping, real event dispatch, and real input/checkbox values.
 *
 * The browser runs headless against a loopback static server serving
 * test/browser/dom-fixture.html, which loads the built library from dist/
 * as plain ES modules (no bundler, no test framework in the page).
 * Skipped when no browser binary or no `ws` dev dependency is available;
 * the rest of the suite is unaffected.
 */

const CHROME_CANDIDATES = [
  process.env.ACTDOWN_BROWSER,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((p): p is string => typeof p === "string" && p.length > 0 && existsSync(p));

let wsAvailable = false;
try {
  require.resolve("ws");
  wsAvailable = true;
} catch {
  wsAvailable = false;
}

const d = (cond: boolean) => (cond ? it : it.skip);

/** Minimal CDP client over the raw WebSocket (send, await matching id). */
class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly events: { method: string; params: Record<string, unknown> }[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      if (typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (p !== undefined) {
          this.pending.delete(msg.id);
          if (msg.error !== undefined) p.reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
          else p.resolve(msg.result);
        }
        return;
      }
      if (typeof msg.method === "string") this.events.push({ method: msg.method, params: (msg.params ?? {}) as Record<string, unknown> });
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }

  close(): void {
    this.ws.close();
  }
}

/** A captured CDP console/log entry (fail the test on page errors). */
interface LogEntry {
  type: string;
  text: string;
}

async function collectConsole(cdp: Cdp): Promise<LogEntry[]> {
  return cdp.events
    .filter((e) => e.method === "Log.entryAdded" || e.method === "Runtime.consoleAPICalled" || e.method === "Runtime.exceptionThrown")
    .map((e) => {
      if (e.method === "Log.entryAdded") {
        const entry = e.params.entry as { level?: string; text?: string; source?: string } | undefined;
        return { type: entry?.level ?? "log", text: entry?.text ?? "" };
      }
      if (e.method === "Runtime.exceptionThrown") {
        const ex = e.params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
        return { type: "error", text: ex?.exception?.description ?? ex?.text ?? "exception" };
      }
      const args = e.params.args as { value?: unknown; description?: string }[] | undefined;
      return { type: "log", text: args?.map((a) => a.value ?? a.description ?? "").join(" ") ?? "" };
    })
    .filter((l) => l.type !== "error" || !/favicon|Failed to load resource/.test(l.text));
}

let server: ReturnType<typeof createServer> | undefined;
let baseUrl = "";
let browserBin: string | undefined;
let browserProc: ChildProcess | undefined;
let wsUrl = "";

beforeAll(async () => {
  if (CHROME_CANDIDATES.length === 0 || !wsAvailable) return;
  browserBin = CHROME_CANDIDATES[0];
  const root = process.cwd();
  server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0]!;
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(join(root, "test", "browser", "dom-fixture.html")));
      return;
    }
    if (url.startsWith("/dist/")) {
      // Only built files under dist/, no traversal.
      const rel = url.slice("/dist/".length).replace(/\.\./g, "");
      const file = join(root, "dist", rel);
      if (!existsSync(file)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(readFileSync(file));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}/`;

  // Spawn headless with a CDP port, then read the chosen port from stderr.
  const port = 9222 + Math.floor(Math.random() * 500);
  browserProc = spawn(browserBin, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--user-data-dir=" + join(root, ".browser-test-profile"),
    "--no-first-run",
    "--disable-extensions",
    "--disable-gpu",
    "--remote-allow-origins=*",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  // Wait for the DevTools HTTP endpoint, then create a page target and keep
  // its PAGE-scoped WS URL: page domains (Page/Runtime/Log) work directly
  // there, while the browser endpoint only accepts Target.*.
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const v = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (v.ok) {
        const t = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
        const meta = (await t.json()) as { webSocketDebuggerUrl: string };
        wsUrl = meta.webSocketDebuggerUrl;
        break;
      }
    } catch {
      // browser not up yet
    }
    if (Date.now() > deadline) throw new Error("browser DevTools endpoint did not come up");
    await new Promise((r) => setTimeout(r, 200));
  }
}, 30_000);

afterAll(async () => {
  server?.close();
  browserProc?.kill();
});

describe("dom adapter in a real browser (SPEC 11)", () => {
  d(CHROME_CANDIDATES.length > 0 && wsAvailable)("runs the fixture end to end over CDP", async () => {
    expect(browserProc).toBeDefined();
    expect(wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/page\//);
    const cdp = new Cdp(wsUrl);
    await cdp.open();
    try {
      cdp.send("Runtime.enable");
      cdp.send("Log.enable");
      cdp.send("Page.enable");
      const navigated = cdp.send("Page.navigate", { url: baseUrl });
      await navigated;

      // Wait for the fixture to report completion.
      let done = false;
      for (let i = 0; i < 100; i += 1) {
        const r = (await cdp.send("Runtime.evaluate", { expression: "window.__done === true", returnByValue: true })) as {
          result: { value: unknown };
        };
        if (r.result.value === true) {
          done = true;
          break;
        }
        await new Promise((res) => setTimeout(res, 100));
      }
      expect(done).toBe(true);

      const r = (await cdp.send("Runtime.evaluate", { expression: "JSON.stringify({results: window.__results, captured: window.__captured})", returnByValue: true })) as {
        result: { value: string };
      };
      const payload = JSON.parse(r.result.value) as {
        results: Record<string, { pass: boolean; detail?: string }>;
        captured: { cap: string; args: unknown }[];
      };
      const failures = Object.entries(payload.results).filter(([, v]) => !v.pass);
      const summary = Object.entries(payload.results).map(([k, v]) => `${k}: ${v.pass ? "pass" : `FAIL (${v.detail ?? ""})`}`).join("; ");
      expect(failures, summary).toEqual([]);
      expect(Object.keys(payload.results).sort()).toEqual([
        "contact_form_phases",
        "counter_click_in_place",
        "counter_initial",
        "each_clones_scoped_bindings",
        "external_set_sync",
      ]);

      // The page must be error-free: no uncaught exceptions, no console errors
      // (favicon noise from the empty fixture page is ignored).
      const problems = (await collectConsole(cdp)).filter((l) => l.type === "error");
      expect(problems, JSON.stringify(problems)).toEqual([]);
    } finally {
      cdp.close();
    }
  }, 60_000);
});

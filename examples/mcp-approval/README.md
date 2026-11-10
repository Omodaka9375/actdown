# MCP approval flow demo

An agent-authored deploy approval document, a host that grants exactly one
capability, and the proof that the refusal path is also correct.

**Run it:** `pnpm build && pnpm demo`

## The story in one screen

1. A release agent writes `approval.ad` (1.6 KB of text). It contains a
   summary table, two buttons, three phase regions, and no code.
2. The host audits it statically: the manifest declares `deploy.approve` and
   `deploy.reject` with scopes. No execution needed.
3. With nothing granted, `render()` produces complete HTML where both buttons
   render `disabled` with `data-cap-missing`. Safe by default.
4. The host hydrates with **only** `deploy.approve` granted.
5. The reviewer clicks Approve: the `when=!approved` guard hides both buttons
   once approved, the pending/success/failure regions switch, and the audit
   entry records who, what, and under which scopes.
6. The reviewer clicks Reject: refused with `E_CAP_MISSING`. The document
   asked; the host said no; nothing ran.

## The MCP mapping

| actdown concept | MCP Apps concept |
|---|---|
| `.ad` document returned by a tool | `ui://` resource rendered by the host |
| `ad-action?name=X` | declared tool the UI can invoke |
| capability map in `hydrate()` | host tool grant list |
| `ad-manifest` | tool annotations / scopes metadata |
| `runtime.fire(id, "click")` | the bridge event handler |
| `ad-region phase=pending/success/failure` | tool-call progress and result states |
| `ad-state` + bindings | shared document state across events |

Key difference vs MCP Apps JS bundles: the artifact is **text**. The model can
re-read its own UI, reviewers can diff it, no bundler is involved, and the
same bytes render with plain Markdown tools (INV-1).

## What the demo prints

Nine labeled sections covering the full arc: document, canonical form, static
audit, ungranted render, hydration, the click, phase transitions, the refusal
of the ungranted capability, and the final HTML plus audit trail.

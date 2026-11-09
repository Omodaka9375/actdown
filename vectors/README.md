# htmldown conformance vectors

This directory is the conformance suite for htmldown draft 0.1 (SPEC 13).
Each vector is a minimal document plus the exact expected outputs of a
conforming implementation. Vectors are stable: after release a vector is
never edited, only added.

## Layout

```text
vectors/
  manifest.json            level + description + required goldens per vector
  0001-basic-prose/
    input.hdm              the document under test
    ast.json               exact canonical AST (toJSON of the canonicalized doc)
    canonical.hdm          exact canonical text form (format(input)); idempotent
    html.html              exact level-1 HTML render (SPEC 11 / Appendix A)
    reactive.html          the state-applied render (SPEC 5/11), when present
```

`reactive.html` is the render with document state applied (bindings
resolved, `when=`/`each=` evaluated, all async phase regions hidden). It is
required for vectors at level 2 and above in this suite; check
`manifest.json` for the authoritative per-vector list.

## Levels

An implementation declares the highest level it supports (SPEC 3); each
vector declares the level it requires. A level-2 implementation runs the
level-0/1 vectors and skips the rest.

| vector | level | what it pins |
|---|---|---|
| 0001-basic-prose | 0 | prose passthrough (INV-1) |
| 0002-state-and-action | 1 | state/data/action blocks, roles |
| 0003-foreign-block | 1 | unknown types preserved verbatim |
| 0004-duplicate-key | 1 | parse errors demote to foreign blocks |
| 0005-generated-id | 2 | generated ids, when=/each= |
| 0006-expr-bindings | 3 | expression language, {expr} bindings |
| 0007-async-regions | 3 | async phase regions |

## Running

The reference implementation runs the suite with:

```sh
pnpm test
```

Regenerate goldens after an intentional behavior change (and say so in the
commit message):

```sh
$env:UPDATE_GOLDENS="1"; pnpm test   # PowerShell
UPDATE_GOLDENS=1 pnpm test           # POSIX
```

## Reporting (other implementations)

For each vector, report exactly one of:

- `pass` — every declared golden matches byte for byte (UTF-8, LF).
- `fail(<vector>:<golden>)` — the named golden differs.
- `skip(<level>)` — the vector requires a level above your declared level.

A suite run is conforming when no vector reports `fail`.

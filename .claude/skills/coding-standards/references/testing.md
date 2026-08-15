# Testing standards

Read before writing or changing any `*.test.ts`.

For a full description of the current suite — what each test does and which ones
are load-bearing — see [`docs/testing.md`](../../../../docs/testing.md). This
file is the rules; that file is the inventory.

## Setup

Vitest, run with `pnpm run test` (`pnpm run test:watch` while iterating).
Config is `vitest.config.ts`, which uses `vite-tsconfig-paths` so `@/*` aliases
resolve in tests exactly as they do in the app.

There is **no** database, no test harness, no global setup file, and no fixture
directory. Do not add one for a single test — the cost of a shared fixture is
paid on every read of every test that uses it.

## Globals are not enabled

Import what you use, at the top of every test file:

```ts
import { describe, expect, it } from "vitest";
import { searchBM25 } from "@/lib/search/bm25";
```

Use `@/*` for anything under `src/` — never a relative `../../lib/...` path.

## Test at the public seam, with no mocks

A **seam** is the exported boundary you observe behaviour through. Call the
exported function, assert on what it returns. The suite currently contains zero
mocks, spies, and stubs; keep it that way.

If a test needs `vi.mock` to reach the code under test, that is a signal about
the design — the dependency wants to be a parameter. `buildBM25Index` takes an
optional `tokenize` function for exactly this reason: it is substitutable
without mocking the module.

Never assert on internals, private helpers, or call counts. The implementation
should be rewritable without touching a single test.

## Build fixtures inline

Corpora and inputs are constructed in the test body, small enough to read at a
glance — two or three words per document, a dozen documents at most. A local
one- or two-line helper is fine when it removes repetition within a file:

```ts
const docs = (entries: Array<[string, string]>): BM25Document[] =>
  entries.map(([id, body]) => ({ id, fields: { body } }));
```

Every input to an assertion should be visible on screen without opening another
file.

## Prefer relational assertions, but anchor them

Assert the relationship that must hold, not a magic number:

```ts
expect(tenScore).toBeGreaterThan(onceScore);
expect(tenScore).toBeLessThan(onceScore * 10);
```

Relational assertions survive tuning `k1`, `b`, and the field weights. But a set
of relational assertions can all pass against a formula that is uniformly wrong,
so each scoring change needs at least one **oracle** test pinning absolute
numbers, with the expected value derived independently — from the spec or a
worked example, never by calling the code under test. See "matches a
hand-computed score on a toy corpus" in `bm25.test.ts`.

An assertion that recomputes the expected value the way the implementation does
is tautological: it passes by construction and can never disagree with the code.

Use `toBeCloseTo` for floats. Never `toBe`.

## Keep tests deterministic

No randomness, no clock, no network, no ordering left to chance. Ties in a
ranked result must be broken explicitly and asserted, or eval scores move for
reasons unrelated to the change.

## Real data

`data/emails.json` may be read directly — it is checked in and stable. Assert
**loosely** against it (a property of the top N, not an exact ordering) and say
so in a comment, because the corpus can grow:

```ts
// Smoke test, not a relevance benchmark — asserted loosely on purpose.
```

An exact-ordering assertion over the real corpus is a false guarantee; it will
fail on unrelated data changes and tells you nothing about ranking quality.

## Unit tests do not measure relevance

Vitest answers "is the maths what we intended?". Whether results are actually
*good* — field weights, stemming, `k1`/`b` — is an eval question. `evalite` is
installed and wired to the vitest config for this. Do not encode a relevance
judgement as a pass/fail assertion; it belongs in a scored eval suite.

## Coverage expectation

Anything in `src/lib/search/` has a matching `*.test.ts`. Beyond that, test what
can be *silently* wrong — scoring, tokenisation, persistence — rather than what
fails visibly on first run. Route handlers and React components are not
currently tested, and adding one is a deliberate decision, not an obligation.

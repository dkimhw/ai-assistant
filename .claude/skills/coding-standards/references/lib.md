# Library module standards

`src/lib/*` holds the logic routes call into. There is no `services/` directory
and no service naming convention — modules are named for what they do
(`search/bm25.ts`, `search/tokenize.ts`, `persistence-layer.ts`).

## Generic core, thin adapter

The house pattern, and the one worth copying. Split a domain into a
corpus-agnostic engine and an adapter that knows the project's data:

- `search/bm25.ts` and `search/tokenize.ts` know nothing about emails. They take
  `{ id, fields }` documents and plain strings.
- `search/emails.ts` is the adapter: it reads `data/emails.json`, maps an `Email`
  onto BM25 fields, and owns the field weights.

The payoff is testability — the engine is tested exhaustively against tiny inline
fixtures, and the adapter needs only a smoke test. Keep project specifics out of
the generic half; if `bm25.ts` ever needs to know what a subject line is, the
split has been broken.

## Document the maths

A module implementing a non-obvious algorithm carries its formulae in a header
comment, in the notation the literature uses:

```ts
/**
 *   idf(t)  = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))          // Lucene variant
 *   score(d) = Σ_t idf(t) · tf~(t,d) · (k1 + 1) / (tf~(t,d) + k1)
 */
```

Name the variant where one exists, and state the consequences of the choice —
the comment in `bm25.ts` explains that weighted tf accumulates across fields
*before* saturation, which is the part a reader would otherwise get wrong.

## Injectable dependencies over mocks

Take the collaborator as an optional parameter with a sensible default, the way
`buildBM25Index` accepts `tokenize`. Tests then substitute it without `vi.mock`,
and the tests stay honest — see [testing.md](testing.md).

## Memoised module singletons

Expensive one-time work is cached at module scope behind a getter, with `??=`:

```ts
let cachedIndex: BM25Index | undefined;

export const getEmailIndex = (): BM25Index => {
  cachedIndex ??= buildBM25Index({ ... });
  return cachedIndex;
};
```

Never do the work at import time — that would run it during the build. Note that
the cache lifetime is the server process, so **it will not pick up changes to the
underlying file** without a restart. That's the right trade for a static corpus
and the wrong one for anything users write to.

## Mark server-only modules

Anything touching `node:fs` or `process.cwd()` must say so in its header comment:

```ts
/** Server-only: reads `data/emails.json` from disk. Do not import from a client
 * component. */
```

Importing one of these from a `"use client"` file is a build error with a poor
message, so the comment is doing real work.

## Honest comments on tuned constants

Magic numbers that were guessed get labelled as guesses:

```ts
/** A starting guess to tune against evals, not a claim. */
const EMAIL_FIELD_WEIGHTS = { subject: 3, body: 1, from: 2, to: 1 };
```

Don't write a justification you don't have.

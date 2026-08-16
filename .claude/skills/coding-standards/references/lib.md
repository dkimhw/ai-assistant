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

### Registries, when there is more than one adapter

`search/documents.ts` is the same pattern one level up: a *registry* of source
adapters and a single entry point, `searchDocuments`, that ranks across all of
them. `search/emails.ts` is now one registered `DocumentSource` rather than the
thing search is built around, and adding a second kind of document is writing an
adapter and registering it.

Two rules that make a registry pay for itself:

- **Namespace identity structurally.** A document id is `${sourceType}:${nativeId}`
  so two sources cannot silently collide, and any id says what it is without a
  lookup. Formatting and parsing live in exactly one module (`document-id.ts`);
  no `split("#")` anywhere else.
- **Make the registry a parameter.** `searchDocuments` takes `sources`, defaulted
  to the registry, for the same reason `buildBM25Index` takes `tokenize`: a test
  proves cross-source behaviour with in-memory fakes and no mock.

The layer above the adapters stays as ignorant as the layer below them: the
document layer mints ids and fuses rankings, and never inspects a document's
content. Anything content-shaped — chunking policy, field choice, weights —
belongs to the source.

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
let cachedEmails: Email[] | undefined;

export const getAllEmails = (): Email[] => {
  cachedEmails ??= JSON.parse(fs.readFileSync(EMAILS_PATH, "utf-8")) as Email[];
  return cachedEmails;
};
```

When the work is cached *per argument* rather than once, key a `WeakMap` on the
argument's identity — `documents.ts` caches one built corpus per `sources` array,
so the registry is indexed once and a test's injected fakes are indexed once
each.

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

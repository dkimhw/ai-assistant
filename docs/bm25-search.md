# BM25 Search

Lexical search over the email corpus. Dependency-free, in-process, built to be the
lexical leg of the hybrid search added later (BM25 + embeddings joined by RRF).

Status: **implemented.** Superseded in part: hybrid search (issue #1) made
`searchEmails` async and fused this ranking with a semantic one, and issue #6
moved indexing and the entry point into a source registry — see
[`hybrid-search.md`](./hybrid-search.md#document-sources). The BM25F ranker itself
is unchanged, and this document still describes it accurately.

## Design constraint

The ranker is corpus-agnostic. Emails are one caller; memories (`DB.Memory`) are a
likely second. Email-specific knowledge lives in a thin adapter, not in the ranker.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Scoring model | **BM25F** (per-field weights) | Lets `subject` outweigh `body`. ~10 lines more than plain BM25. |
| Retrieval unit | **Per-email** | Matches the shape of `data/emails.json`; embeddings will inherit this unit. |
| Filters (`arcId`, dates) | **Not in v1** | Pure ranking. Filters belong in the agent-tool wrapper, which knows the query language it wants to expose. |
| Stopwords | **On by default** | Better ranking on natural-language queries. Caveat: an all-stopword query returns nothing. |
| Stemming | **None** | Every JS stemmer is either a dependency or a 200-line Porter transcription, and it costs recall correctness in confusing ways. Revisit only if evals show plural/tense misses. |
| IDF variant | **Lucene** (`ln(1 + …)`) | Always positive; the textbook variant goes negative for terms in >50% of documents, which matters on a 547-document corpus. |

## Files

```
src/lib/search/tokenize.ts   # text -> string[]
src/lib/search/bm25.ts       # buildBM25Index / searchBM25  (no email knowledge)
src/lib/search/emails.ts     # email adapter + cached singleton index
src/lib/search/bm25.test.ts  # vitest
```

`src/lib/search/` rather than flat `src/lib/`, so `embeddings.ts` and `rrf.ts` land
beside it later.

Also adds `"test": "vitest run"` and `"test:watch": "vitest"` to `package.json` —
there is currently no test script, though `vitest` and `vitest.config.ts` are already
set up.

## Public API

Object-param style, per `CLAUDE.md`.

```ts
// bm25.ts
export type BM25Document = {
  id: string;
  fields: Record<string, string>; // e.g. { subject, body, from, to }
};

export type BM25Options = {
  k1?: number;                            // default 1.2
  b?: number;                             // default 0.75
  fieldWeights?: Record<string, number>;  // default: every field weight 1
  tokenize?: (text: string) => string[];  // default: ./tokenize
};

export type BM25Index = {
  /* opaque; see "Index structure" */
};

export type BM25Result = {
  id: string;
  score: number;        // unbounded positive, corpus-relative; not a probability
  matchedTerms: string[];
};

export function buildBM25Index(opts: {
  documents: BM25Document[];
} & BM25Options): BM25Index;

export function searchBM25(opts: {
  index: BM25Index;
  query: string;
  limit?: number;       // default 10
  minScore?: number;    // default 0 — drop zero-score documents
}): BM25Result[];
```

```ts
// emails.ts
export type Email = {
  id: string; threadId: string; from: string; to: string;
  subject: string; body: string; timestamp: string;
  arcId: string; phaseId: number;
};

export function getAllEmails(): Email[];               // memoised module singleton
export function searchEmails(opts: {
  query: string; limit?: number;
}): Array<{ email: Email; score: number }>;
```

`getAllEmails()` reads `data/emails.json` once and caches it. Server-only (it uses
`fs`); it must not be imported from a client component. The index built over those
emails is memoised by the document layer rather than here — see `documents.ts`.

## Scoring

BM25F. A weighted term frequency is accumulated across fields *before* saturation —
scoring each field separately and summing the results would over-reward a document
that matches weakly in many fields.

```
idf(t)   = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))

tf̃(t,d)  = Σ_f  w_f · tf(t, d.f) / (1 - b + b · len(d.f)/avgdl_f)

score(d) = Σ_t  idf(t) · tf̃(t,d) · (k1 + 1) / (tf̃(t,d) + k1)
```

- `N` = document count, `df(t)` = number of documents containing `t`.
- Length normalisation is **per-field**, so a long body no longer dilutes a subject
  hit. `df` and `idf` remain document-level.
- Defaults: `k1 = 1.2`, `b = 0.75`.
- Query terms are tokenised with the same tokenizer, then **de-duplicated** — a
  repeated word in a short query should not double its weight.
- Terms absent from the index contribute 0 and are excluded from `matchedTerms`.
- Multiple terms combine as OR (sum of contributions). No AND, phrase, or proximity
  matching in v1.

Email field weights: `subject 3, body 1, from 2, to 1`. A starting guess to tune
against evals, not a claim.

## Index structure

Built once, immutable — no incremental add/remove in v1. A rebuild is a few
milliseconds at 547 documents.

```ts
type BM25Index = {
  docIds: string[];                              // dense idx -> external id
  fieldLengths: Record<string, Float64Array>;    // field -> per-doc token count
  avgFieldLength: Record<string, number>;
  postings: Map<string, Array<{ doc: number; tf: Record<string, number> }>>;
  df: Map<string, number>;
  docCount: number;
  options: Required<BM25Options>;
};
```

Search walks only the postings lists of the query terms, accumulating into a
`Map<number, number>`, then partial-sorts by score. Complexity is
`O(Σ df(t) · fields + k log k)`. Memory at 547 emails is a few MB.

Ties break by ascending document index, so results are deterministic at equal scores.

## Tokenizer

`tokenize(text: string): string[]`

1. Unicode `NFKC` normalise, lowercase.
2. Split on `/[^\p{L}\p{N}]+/u` — letters and numbers survive, punctuation separates.
3. Drop tokens of length 1.
4. Drop stopwords from a small inline English list (~40 words: the, a, is, to, of,
   and, …).

Email addresses get one extra rule before step 2: an address matched by
`/[\w.+-]+@[\w.-]+\.\w+/` emits the **full address as one token** *and* its component
words. So `david.xu@firsthomemortgages.co.uk` yields
`david.xu@firsthomemortgages.co.uk`, `david`, `xu`, `firsthomemortgages`, `co`, `uk` —
a query for either the whole address or just "david xu" hits.

## Tests

Correctness:

- A term appearing in one document ranks that document first.
- A rarer term outweighs a common one at equal tf (IDF works).
- With `b = 0.75` a short document beats a long one at equal tf; with `b = 0` the two
  tie (length normalisation works).
- tf saturates: 10 occurrences score less than 10× one occurrence.
- BM25F: a subject-only match outranks a body-only match under the field weights above.
- A hand-computed score on a 3-document toy corpus, asserted to ~6 decimal places
  against the formula above.

Tokenizer: punctuation, casing, unicode (`café` → `café`), stopword removal, email
address splitting.

Edges:

- Empty query → `[]`. Query of only stopwords → `[]`. Query with no index hits → `[]`.
- Empty corpus → `[]`, with no divide-by-zero from `avgdl = 0`.
- Single-document corpus (`df = N`; IDF must stay positive — the reason for the
  Lucene variant).
- A document with an empty field.
- `limit` larger than the result count.

Real data (one test, against `data/emails.json`): a query like
`"mortgage pre-approval"` returns the mortgage thread in the top 3. Asserted loosely —
it is a smoke test, not a relevance benchmark.

## Non-goals for v1

Phrase and proximity queries, fuzzy or prefix matching, boolean operators, incremental
index mutation, index serialisation to disk, snippet and highlight generation,
embeddings and RRF (separate workshop steps), and exposing this as an agent tool (also
separate — the tool wrapper wants filters like `arcId` and a date range alongside the
query).

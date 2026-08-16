# Hybrid search

Semantic search over the email corpus, fused with the existing BM25F lexical ranker.
Implements GitHub issue #1.

Status: **implemented.** Superseded in part by issue #6, which moved the adapter
boundary — see [Document sources](#document-sources) below.

## The problem

BM25F scores term overlap. A search for _"when do I need to pay the solicitor"_ returns
nothing useful when the relevant email says _"completion funds must clear before
exchange"_ — the two phrases share no terms despite being about the same thing. People
remember what an email was _about_, not the sender's vocabulary, and the failure is
silent: an empty page looks the same whether nothing matched your wording or nothing
like it exists.

Measured on the real corpus, the lexical top 5 for
_"when do I need to hand over the remaining money before I can pick up the keys"_ is:

```
1  Re: Training goals - 5.10 to 5.11 progression
2  Re: New Price Alert: Manchester to Auckland
3  Congratulations on your offer! 🏡
4  Re: Workshop Testimonial Request
5  Re: Long time no chat! New Zealand trip?
```

The right answer — _Exchange of Contracts_ — sits at lexical rank 12. After fusion it is
rank 1. That single query is the whole feature.

## Design constraint

Unchanged from BM25: the rankers are corpus-agnostic, and every email-specific decision
lives in the adapter. Chunking, quote stripping and field selection are adapter
concerns; vectors and dot products are ranker concerns. Since issue #6 there is a third
layer between them — the document layer, which owns identity and the source registry and
also never looks at content. The lexical ranker and tokenizer
were **not modified**, and the search page changed by one `await`.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Vector store | **None** — a flat `Float32Array`, scanned exhaustively | 606 vectors × 1536d is ~3.7 MB and under a millisecond to scan exactly. A vector DB would add an operational dependency and approximation error to solve a problem three orders of magnitude away. |
| Fusion | **Reciprocal Rank Fusion**, `k = 60` | BM25 scores are unbounded and corpus-relative; cosine is bounded. There is no principled way to add them, and per-query normalisation is unstable on small result sets. RRF keeps only the ordering, which is all fusion needs. |
| Embedding model | **OpenAI `text-embedding-3-small`**, 1536d | One obvious default. Reached through the AI SDK's `embedMany`, so a provider swap is one implementation plus a rebuild. |
| When vectors are computed | **Build step**, committed artifact | Serving a search never pays to embed the corpus, and the app and tests run with no API key. |
| Retrieval unit | **Per-email**, chunked internally | Long bodies are split for embedding, then collapsed back to their best-scoring chunk. The ranker returns emails, not fragments. |
| Query embedding | **At request time**, no cache | ~100–400 ms per search. Acceptable for a server-rendered page; the constraint that would change this is search-as-you-type. |
| Provider outage | **Degrade to lexical-only** | An explicit `catch` and a `console.warn`, not an incidental one. |

## Files

```
src/lib/search/semantic.ts        # buildSemanticIndex / searchSemantic  (no email knowledge)
src/lib/search/rrf.ts             # fuseRRF — pure, no I/O
src/lib/search/embedder.ts        # Embedder interface + OpenAI implementation
src/lib/search/email-chunks.ts    # email → embeddable texts (quote stripping, chunking)
src/lib/search/vector-artifact.ts # base64 Float32 packing + staleness checks
src/lib/search/documents.ts       # document layer: registry, ids, runs both rankers, fuses
src/lib/search/document-id.ts     # the id scheme, formatting and parsing
src/lib/search/emails.ts          # the email source adapter
scripts/build-email-vectors.ts    # pnpm run build:vectors
data/email-vectors.json           # 606 chunk vectors, 4.99 MB, committed
data/query-vectors.json           # real embeddings of the test queries, 0.05 MB, committed
```

## Public API

```ts
// semantic.ts
export type SemanticDocument = { id: string; vector: Float32Array };
export type SemanticResult = { id: string; score: number };  // cosine, [-1, 1]

export function buildSemanticIndex(opts: {
  documents: SemanticDocument[];
}): SemanticIndex;

export function searchSemantic(opts: {
  index: SemanticIndex;
  queryVector: Float32Array;
  limit?: number;      // default 10
  minScore?: number;   // default 0
}): SemanticResult[];

export function l2Normalise(vector: Float32Array): Float32Array;
```

```ts
// rrf.ts
export function fuseRRF(opts: {
  rankings: string[][];   // each ranker's ids, best first
  k?: number;             // default 60
  limit?: number;
}): Array<{ id: string; score: number }>;
```

```ts
// embedder.ts
export type Embedder = {
  model: string;
  dimensions: number;
  embed: (opts: { texts: string[] }) => Promise<Float32Array[]>;  // L2-normalised
};

export function createOpenAIEmbedder(opts?: {
  model?: string; dimensions?: number; apiKey?: string;
}): Embedder;
```

```ts
// documents.ts — the entry point since issue #6
export function searchDocuments(opts: {
  query: string;
  limit?: number;
  sources?: DocumentSource[];  // defaults to the registry; tests inject fakes
  embedder?: Embedder;         // defaults to the configured OpenAI embedder
}): Promise<Array<{ document: SearchDocument; score: number }>>;

// emails.ts — a thin wrapper over it, so the search page still gets emails
export function searchEmails(opts: {
  query: string;
  limit?: number;
  embedder?: Embedder;
}): Promise<Array<{ email: Email; score: number }>>;
```

`searchEmails` is now `async`. Its return shape is unchanged, so consumers see only the
added `await`. The score is now a fused RRF score rather than a BM25 score; as before it
is an ordering signal with no absolute meaning.

## Scoring

Every vector is L2-normalised when it is produced, so cosine similarity collapses to a
dot product:

```
score(d) = cos(q, d) = q · d
```

Fusion combines the two rankings by position:

```
score(id) = Σ over rankings of  1 / (k + rank(id))       // rank 1-based, k = 60
```

Ids absent from a ranking contribute nothing from it. Ties break by first appearance
across the rankings in order, which makes the output deterministic. Each ranker is asked
for `max(40, 4 × limit)` candidates so fusion has material to work with, and the
**semantic pool is additionally capped at 50** regardless of the limit: the search page
requests the whole corpus so it can paginate, and without the cap the semantic leg
becomes "every email above the floor", padding the result count with a long tail of
loosely-related emails. A term match is evidence; a cosine of 0.31 is barely a hint.

A worked example from the query above: _Exchange of Contracts_ is lexical rank 12 and
semantic rank 1, giving `1/72 + 1/61 = 0.03028`. The lexical winner, _Training goals_,
is absent from the semantic ranking and scores `1/61 = 0.01639` — fourth.

## Chunking

In `src/lib/search/email-chunks.ts`, because it is email-specific knowledge. The
alternatives considered and the reasoning behind each choice below are in
[`chunking.md`](./chunking.md).

1. **Strip quoted reply text** — `>`-prefixed lines, Gmail/Apple attribution lines, the
   Outlook separator, and header blocks. 13 of 547 emails are affected. Without this,
   every message in a thread produces a near-identical vector and one conversation
   dominates the results.
2. **Prepend the subject** to the body, mirroring the lexical index where `subject`
   already outweighs `body`.
3. **Exclude sender and recipient addresses.** Pure lexical signal; embedding them
   dilutes the vector without adding retrieval power.
4. **Split bodies over 1,500 characters** on paragraph boundaries into ~1,200-character
   chunks with one paragraph of overlap. 16 of 547 emails qualify, producing 606 chunks
   in total. The threshold comes from the corpus's character distribution (median 434,
   p90 730, max 6,660), not from measured retrieval quality.
5. **Collapse chunks to their parent email** at query time, each email taking its
   best-scoring chunk.

### One vote per distinct text

143 of the 606 chunks are byte-identical to another — automated notifications like
"Your monthly statement is ready", 16 of them the same, each with its own email id and
its own thread id. Indexed individually they carry identical vectors and take the top 16
semantic slots as a block, pushing every unique email off the page. Measured before the
fix: `mortgage pre-approval` returned 7 identical bank notifications in its top 8, with
the two emails a person actually wanted at rank 5 and below.

So the semantic index holds **one representative per distinct text**. This is not a
display policy — identical text should get one vote, not sixteen. The duplicates remain
fully findable through BM25, which scores them on their own terms, and the index shrinks
from 606 vectors to 463.

## The vector artifact

`data/email-vectors.json`, 4.99 MB, committed.

```ts
type VectorArtifact = {
  model: string;         // "text-embedding-3-small"
  dimensions: number;    // 1536
  fingerprint: string;   // sha256 of the exact chunks embedded: ids and texts
  ids: string[];         // chunk ids, `${documentId}#${n}`
  vectors: string;       // base64 of ids.length × dimensions little-endian Float32s
};
```

Vectors are packed as base64 Float32 rather than JSON number arrays: the naive encoding
of 606 × 1536 floats is over 10 MB of text, and the packed form decodes with one
`Buffer.from`. `text-embedding-3-small` can return fewer dimensions, which shrinks the
file roughly proportionally at some cost to quality — a documented knob, not a default.

The fingerprint covers the embedded **chunks** — their ids as well as their texts — so it
moves when the corpus changes, when the chunking policy changes, _and_ when the id scheme
changes. Loading revalidates model, dimension count and fingerprint, and throws with a
rebuild instruction on any mismatch. Stale vectors degrade relevance silently, which is
worse than a loud failure at startup.

The ids are in the digest because of a trap issue #6 walked into: namespacing every id
leaves every text byte-identical, so a digest over texts alone would have kept accepting
an artifact whose ids no longer resolved to any document — search that works, ranks
correctly, and returns an empty page.

## Build step

```bash
pnpm run build:vectors      # tsx --env-file-if-exists=.env scripts/build-email-vectors.ts
```

Reports model, email count, chunk count, token estimate and output size. Fails
immediately with an actionable message when no API key is configured — there is no
meaningful partial success. Reads `OPENAI_API_KEY`, falling back to `OPEN_AI_API_KEY`,
which is what this repo's `.env` calls it.

The whole corpus is ~75k tokens, about a fifth of a cent at current rates. **Latency is
the real cost**, not money: every search now makes a round-trip to embed the query,
adding roughly 100–400 ms to a search that used to complete in single-digit
milliseconds.

It also writes `data/query-vectors.json` — real embeddings of the exact query strings
the test suite uses, so tests get genuine semantic neighbourhoods with no network and no
API key.

## Failure and degradation

| When | What happens |
| --- | --- |
| No API key at query time, or the embedding call fails | `console.warn`, semantic leg dropped, lexical-only results. Fusion still runs over one ranking, which preserves the lexical order exactly. |
| No API key at build time | Build fails immediately with a clear message. |
| Artifact missing or header mismatched | Loading throws with a rebuild instruction. **Deliberately not covered by the fallback above** — the index is fetched outside the `try`. A provider outage is transient and outside our control; a stale artifact is a build step somebody forgot, and quietly serving worse results for it is precisely the silent degradation the fingerprint exists to prevent. |
| Empty or whitespace query | `[]`, with no embedding round-trip. The no-query browse path never calls `searchEmails` at all. |
| Nothing above the cosine floor (0.3) | Semantic contributes nothing, so a query about nothing in the corpus still returns nothing. Measured: the nonsense query `zzzzqqqxyzzy` peaks at 0.214 against all 606 chunks; the conveyancing query clears 0.3 on 17 of them. |
| The rerank call fails | `console.warn`, and the fused ordering is returned cut to the limit. Same contract as the embedder: an outage costs relevance, not the feature. |
| The reranker returns a partial or malformed order | Unknown and repeated ids are dropped; anything it left out keeps its fused position at the end of the list. A partial answer costs ordering, not recall. |

## Reranking

A fourth, optional stage, added after fusion for the chat tool only (issue #11).

The fused top five was the wrong five often enough to matter, and the tool showed
the model the first 1,200 characters of each email — so an answer in the fourth
paragraph of a long lender email was found by the search layer, embedded as a
chunk, and then not shown. Reranking addresses both at once.

- **Deeper pool.** With a reranker, fusion runs to `RERANK_CANDIDATE_POOL` (25)
  documents rather than the caller's limit, so there is something to reorder.
  That is a floor, not a ceiling — a caller asking for more results needs a pool
  at least that deep. `RERANK_MAX_CANDIDATES` (50) is the real bound, and it
  counts *chunks*, because passages are what a model call pays for. They
  coincide for email at 1.1 chunks per document; a source that split a long
  document into thirty pieces would find out why the second constant exists.
- **Chunks, not documents.** The pool's chunks are what get read and ordered,
  then collapse one-per-document taking the best — the same collapse the semantic
  leg already performs. A long document is relevant because one paragraph answers
  the question, not on average.
- **The winning passage travels with the result.** `DocumentResult.chunk` is what
  the tool sends the model in place of the body's opening. The chunk already has
  quoted text stripped and the subject prepended, so it is self-contained.
- **A passage says that it is one.** It carries its position (`index`, `count`),
  and the tool marks a passage with more email after it using the same ellipsis
  truncation uses — both mean "there is more of this than you are looking at".
  That a passage may also *begin* mid-email, or omit quoted history, is stated in
  the system prompt: an excerpt that reads as a whole email is how a model
  concludes a message does not mention something it does mention. The prompt's
  rule is now "an email saying nothing about X in a search result is not evidence
  that it says nothing about X — call `getEmails`".
- **No score is exposed.** `Reranker.rerank` returns an order, not scores — a
  rerank score means nothing outside its own call, and returning only the order
  makes that structurally true rather than a comment someone has to obey.
- **Conversation context.** The tool passes the last
  `EMAIL_SEARCH_HISTORY_MESSAGES` (6) user and assistant messages, each cut to
  `EMAIL_SEARCH_HISTORY_CHARACTERS` (400) — a message count alone does not bound
  a prompt, since one pasted document would ride along in every rerank call for
  the rest of the conversation. A follow-up is then judged against what was being
  discussed. Tool calls and results are filtered
  out: they are bulky, already summarised by the assistant's reply, and feeding a
  retrieval system its own retrievals sticks a conversation in one neighbourhood
  of the corpus. Context reaches the reranker only — the lexical and semantic
  legs still see just the query. Rewriting the query before retrieval is a
  separate piece of work.

Passages are fenced in the rerank prompt and the model is told that what sits
inside a fence is quoted material rather than instructions. Email is
attacker-supplied text — anyone can send the user some — and the stage's whole
job is to read it. The exposure is bounded (an ordering can move; no tool runs),
but "rank this passage first" should not work on a search engine.

`reranker.ts` mirrors `embedder.ts`: a provider-agnostic interface over opaque
ids and text, plus one implementation on the nano tier already configured here.
A dedicated cross-encoder (Cohere, Voyage) is the anticipated successor, and the
interface exists so that swap is one new implementation and no pipeline change.

Cost is one extra model call per tool call, on a turn that already makes an
embedding call and at least two chat completions. The search page passes no
reranker and is unchanged in results, cost, and pagination.

Both the pool depth and the history depth are starting positions to tune against
evals. Pool depth first: it bounds what reranking can possibly fix.

## Tests

71 tests, 6 files. The 29 existing BM25 and tokenizer tests pass **unmodified** — the
lexical path was not disturbed.

Two seams, plus two mechanisms that would otherwise fail silently:

- **`rrf.test.ts` (17)** — exhaustive pure unit tests, in the style of `bm25.test.ts`.
  A hand-computed RRF score as the oracle; agreement beating a single first place;
  the convexity of `1/(k+r)`; determinism under ties; monotonicity in `k`; one empty
  ranking degrading to the other's order; both empty; limit.
- **`documents.test.ts` (17)** — cross-source behaviour through the one public seam,
  with in-memory fake sources passed as `sources`: two sources minting the same native
  id stay two documents, a result carries the source that supplied it, a reserved
  character in a native id throws with the id in the message, a source declaring no
  native ids gets stable content-derived ones, a chunked document collapses to one
  result, and a rejecting embedder degrades to lexical-only. Plus the guards whose
  failure mode is a lost document rather than an error: a source minting one id for two
  documents, a vector for a chunk that does not exist, and the memoisation contract that
  keeps a set of sources indexed once.
- **`emails.test.ts` (9)** — loose adapter smoke tests with an injected embedder that
  serves the committed query vectors. A conceptual query with no lexical overlap finds
  the conveyancing thread; an exact address still lands first; a nonsense query returns
  `[]`; a block of identical emails does not
  take every top slot; a rejecting embedder falls back to lexical-only instead of
  throwing.
- **`vector-artifact.test.ts` (11)** — the staleness contract, pinned directly: a changed
  corpus, model, or dimension count throws with a rebuild instruction, and the base64
  Float32 packing round-trips. Its failure mode is a search that keeps working while
  ranking against vectors for text that no longer exists, so it is not left to the
  adapter's smoke tests.
- **`email-chunks.test.ts` (9)** — quote stripping across the conventions we claim to
  handle, subject prepending, and the long-body split. A miss here is invisible in every
  other test and shows up only as thread clustering in results.

**Not separately seamed:** the semantic ranker and the index builder. Semantic scoring
is a normalised dot product and a sort; it is covered through the adapter, and giving it
its own seam would test structure rather than behaviour. A deliberate departure from
mirroring the BM25 module one-for-one.

## Document sources

Issue #6 finished the split this document started. The rankers were already
corpus-agnostic; what was still email-bound was *identity*, and identity is what the
artifact on disk is keyed by.

A document id is now namespaced by its source:

```
document id  = `${sourceType}:${nativeId}`   // email:email_1759404204639_rcsddgue6
chunk id     = `${documentId}#${n}`          // email:email_1759404204639_rcsddgue6#2
```

Uniqueness across sources is structural rather than hoped for — two sources may mint the
same native id and still be two documents — and any id answers "what kind of thing is
this?" without a lookup. `:` and `#` are reserved; a native id containing either is
rejected at index time with the offending id in the message, because the failure it
would otherwise cause is a document silently missing from every result. Formatting and
parsing live in `document-id.ts` and nowhere else.

A source with stable ids of its own keeps them: the 547 email ids stay greppable against
`emails.json`, and a content-addressed id would move every time a body was edited,
breaking any stored reference to it. A source with no identity of its own — a text file
dropped into a folder, a scraped page — gets a truncated SHA-256 of its text instead, so
it can join the corpus without a registry handing out identifiers. Hashing is the
fallback, not the rule.

`documents.ts` owns the registry and the single public entry point. A source is:

```ts
type DocumentSource = {
  sourceType: SourceType;                    // "email"
  fieldWeights: Record<string, number>;      // this source's property
  hasNativeIds?: boolean;                    // false → ids are hashed from chunkText
  all: () => SourceDocument[];
  chunk: (opts: { document: SearchDocument }) => DocumentChunk[];
  vectors?: (opts: { chunks: DocumentChunk[] }) => Array<{ id: string; vector: Float32Array }>;
};
```

The layer mints ids, unions the sources into one BM25F index (weights merged, with a
disagreement over a shared field name an error rather than a silent overwrite) and one
semantic index, and collapses chunk hits back to documents. It never inspects a
document's content: chunking generalizes by delegation, and the email chunking policy is
unchanged and now lives behind `emailSource.chunk`.

Adding a second kind of document is: write an adapter, register it, rebuild the vectors.
No ranking, chunking, or fusion code moves — `bm25.ts`, `semantic.ts`, and `rrf.ts` took
a zero diff. Genericity is demonstrated by fake in-memory sources in `documents.test.ts`;
email remains the only registered source, and relevance is unchanged.

### Left for the second source

Two things are correct with one source and want a decision the moment there are two:

- **BM25F length statistics are pooled.** Weights are per source, but the index is one
  index, so `avgFieldLength` is computed across every source's documents. A source with
  no `subject` field would push a mass of zero-length subjects into that average and
  quietly demote subject matches for email. Wants either per-source length normalisation
  or source-namespaced field names.
- **`sourceTypes` filters the candidate pool, not the corpus.** `searchEmails` narrows to
  email before the limit, so `limit` still means "this many emails" — but the pool it
  narrows is a fixed size, so a heavily mixed corpus could under-fill it. That is a
  relevance cost, not a correctness one, and the pool sizes are worth tuning against a
  real second source rather than a guess.

## Non-goals

Vector databases and ANN indexes, cross-encoder or LLM re-ranking, query expansion and
spelling correction, incremental index updates, a relevance evaluation harness (worth
doing, its own piece of work), any change to the search UI, semantic search anywhere
outside the email archive page, streaming results to mask embedding latency, caching
query embeddings, tuning `k` / chunk size / the cosine floor against measured relevance,
and shipping a second embedding provider.

## Two things most likely to need revisiting

1. **The quote-stripping heuristic.** Email quoting conventions vary; a miss shows up as
   thread clustering in results.
2. **The 1,500-character chunk threshold**, currently set by the corpus's character
   distribution rather than by measured retrieval quality.

Both want the evaluation harness that does not exist yet. So does the cosine floor of
0.3, and the field weights before it.

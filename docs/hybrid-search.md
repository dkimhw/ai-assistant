# Hybrid search

Semantic search over the email corpus, fused with the existing BM25F lexical ranker.
Implements GitHub issue #1.

Status: **implemented.**

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
concerns; vectors and dot products are ranker concerns. The lexical ranker and tokenizer
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
src/lib/search/emails.ts          # adapter: runs both rankers, fuses  (modified)
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
// emails.ts — the one breaking change
export function searchEmails(opts: {
  query: string;
  limit?: number;
  embedder?: Embedder;    // defaults to the configured OpenAI embedder
}): Promise<Array<{ email: Email; score: number }>>;

export function getEmailSemanticIndex(): SemanticIndex;  // memoised module singleton
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

In the build script, because it is email-specific knowledge.

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
  fingerprint: string;   // sha256 of the exact texts embedded
  ids: string[];         // chunk ids, `${emailId}#${n}`
  vectors: string;       // base64 of ids.length × dimensions little-endian Float32s
};
```

Vectors are packed as base64 Float32 rather than JSON number arrays: the naive encoding
of 606 × 1536 floats is over 10 MB of text, and the packed form decodes with one
`Buffer.from`. `text-embedding-3-small` can return fewer dimensions, which shrinks the
file roughly proportionally at some cost to quality — a documented knob, not a default.

The fingerprint covers the embedded **texts**, so it moves when the corpus changes _and_
when the chunking policy changes. Loading revalidates model, dimension count and
fingerprint, and throws with a rebuild instruction on any mismatch. Stale vectors
degrade relevance silently, which is worse than a loud failure at startup.

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

## Tests

71 tests, 6 files. The 29 existing BM25 and tokenizer tests pass **unmodified** — the
lexical path was not disturbed.

Two seams, plus two mechanisms that would otherwise fail silently:

- **`rrf.test.ts` (17)** — exhaustive pure unit tests, in the style of `bm25.test.ts`.
  A hand-computed RRF score as the oracle; agreement beating a single first place;
  the convexity of `1/(k+r)`; determinism under ties; monotonicity in `k`; one empty
  ranking degrading to the other's order; both empty; limit.
- **`emails.test.ts` (10)** — loose adapter smoke tests with an injected embedder that
  serves the committed query vectors. A conceptual query with no lexical overlap finds
  the conveyancing thread; an exact address still lands first; a nonsense query returns
  `[]`; both indexes are built once per process; a block of identical emails does not
  take every top slot; a rejecting embedder falls back to lexical-only instead of
  throwing.
- **`vector-artifact.test.ts` (9)** — the staleness contract, pinned directly: a changed
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

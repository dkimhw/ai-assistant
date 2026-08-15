# Testing in this repo

A description of what the test suite currently is, what each test buys us, and
which tests are load-bearing enough to be worth your review time.

Status as of this document: **84 tests, 8 files, all passing, ~500ms.**
Almost every test lives in `src/lib/search/`; the one exception is described
below and is a deliberate one.

```
src/lib/search/tokenize.test.ts           8 tests
src/lib/search/bm25.test.ts              18 tests
src/lib/search/rrf.test.ts               17 tests
src/lib/search/email-chunks.test.ts       9 tests
src/lib/search/vector-artifact.test.ts    9 tests
src/lib/search/emails.test.ts            10 tests
src/lib/search/email-search-tool.test.ts 10 tests
src/app/api/chat/tools.test.ts            3 tests
```

> The test-by-test breakdown in section 3 covers `tokenize`, `bm25`, `rrf`,
> `emails`, `email-search-tool`, and `tools`. `email-chunks.test.ts` and
> `vector-artifact.test.ts` arrived with hybrid search and are not yet described
> there. `documents.test.ts` arrived with source-namespaced ids (issue #6) and is
> summarised below.

Run with `pnpm run test` (`vitest run`) or `pnpm run test:watch`.

> `fuseRRF` is now wired up: `emails.ts` fuses the BM25F and semantic rankings
> through it, and `email-search-tool.ts` is a second consumer of that same
> pipeline. Gap 2 below, which was written when it had no callers, is stale in
> that respect — but its substance is not. Nothing measures whether the fused
> ordering is *good*.

---

## 1. The philosophy, as actually practised

These are descriptions of what the suite does, not aspirations.

**Test the algorithm, not the application.** 100% of tests target the search
layer. The Next.js routes, the chat UI, and `src/lib/persistence-layer.ts` have
no tests at all. This is a deliberate concentration of effort: search is the only
part of the codebase where a change can be silently wrong. A broken UI is visible
on first load; a subtly broken IDF term just returns slightly worse results
forever.

**Pure functions at a public seam. Zero mocks.** There is not a single `vi.mock`,
spy, or stub in the suite. Every test calls the exported public API (`tokenize`,
`buildBM25Index`, `searchBM25`, `fuseRRF`, `searchEmails`) and asserts on the
returned value. Nothing reaches into internals. The consequence: the entire
implementation could be rewritten and the tests would still be valid.

**Assertion style is chosen per module, by how exact the maths is.** The two
scoring modules are tested differently on purpose, and the difference is
principled:

- `bm25.test.ts` is **mostly relational** — "the rarer term scores higher", "10
  occurrences beat 1 but not by 10×" — because `k1`, `b`, and the field weights
  are tuning knobs expected to move. Relational assertions survive tuning. One
  oracle test pins absolute numbers so the relational ones can't all pass against
  a uniformly wrong formula.
- `rrf.test.ts` is **mostly exhaustive and absolute** — most tests assert exact
  scores to 9 decimal places — because RRF is closed-form rank arithmetic with a
  single constant. There is nothing to tune into a different shape, so there is
  no reason to settle for a weaker assertion. Its file header says as much.

Match the style to the module. Don't assert exact floats over something you
intend to tune, and don't settle for `toBeGreaterThan` over something exact.

**Oracles are transcribed from the definition, never from the code.** Both
scoring modules carry a test whose expected values are worked out by hand from
the published formula. `rrf.test.ts` states the rule explicitly in its header:
expected numbers "are transcribed from the definition … and never derived by
calling the implementation". That is what separates an oracle from a tautology.

**Surprising-but-correct behaviour gets pinned and explained.** Where the maths
produces a result a reader would assume is a bug, there's a test *and* a comment
deriving it — see the convexity test in `rrf.test.ts`, which documents that
1st + 3rd narrowly beats 2nd + 2nd. Pinning it stops someone "fixing" it later.

**Fixtures are inline and tiny.** Corpora and rankings are built in the test
body — two or three words per document, a handful of ids per ranking. Every input
to every assertion is visible on screen. No fixture files, and no shared factory
beyond a one-line `docs()` / `ids()` helper per file.

**Real data gets exactly one loose test.** `emails.test.ts` touches the real
`data/emails.json` (500+ emails), and its relevance assertion is deliberately
weak — "a mortgage email appears somewhere in the top 3". The test file says so
in a comment. This is a *smoke test*, guarding against the pipeline being
catastrophically broken, not a measure of ranking quality.

**Ranking quality is explicitly out of scope for vitest.** Both
`docs/bm25-search.md` and `src/lib/search/emails.ts` defer the real questions
(are these field weights right? does skipping stemming cost recall? is `k = 60`
right for two rankings?) to "evals". See the gaps section — that harness still
does not exist.

---

## 2. Concepts and definitions

### Retrieval concepts

| Term | Definition |
| --- | --- |
| **tf** (term frequency) | How many times a term occurs in a document. More occurrences → more relevant, but with diminishing returns. |
| **df** (document frequency) | How many documents in the corpus contain the term. `N` is the total document count. |
| **idf** (inverse document frequency) | How informative a term is. Rare terms carry more signal. This repo uses the Lucene variant `ln(1 + (N − df + 0.5) / (df + 0.5))`, which is **always positive** — some other BM25 variants go negative for terms in >50% of documents, which lets a common term subtract from a score. |
| **Saturation** | The `tf·(k1+1) / (tf+k1)` shape. The 2nd occurrence of a word adds much less than the 1st, and the 50th adds almost nothing. `k1` (default 1.2) controls how fast it flattens. |
| **Length normalisation** | Dividing tf by `1 − b + b·(len/avgLen)` so a long document doesn't win just by containing more words. `b` (default 0.75) is the strength: `b = 0` disables it entirely, `b = 1` fully normalises. |
| **BM25F** | The multi-field extension. Each field (subject, body, from, to) gets a weight and its *own* average length. Critically, weighted tf is summed across fields **before** saturation is applied — otherwise a document matching weakly in four fields would beat one matching strongly in the subject. |
| **Field weights** | `{ subject: 3, body: 1, from: 2, to: 1 }`. A subject hit counts triple. The source comments this as "a starting guess to tune against evals, not a claim". |
| **Stopwords** | The ~60 function words dropped at tokenise time (`the`, `and`, `is`…). They carry no retrieval signal and appear everywhere. Consequence: they are **unsearchable** — a query of only stopwords returns `[]`. |
| **minScore** | A floor; results scoring at or below it are dropped. Defaults to `0`, so zero-scoring documents never surface. |
| **Tie-break** | When two candidates score identically, order is decided explicitly rather than left to chance. BM25 uses the lower corpus index; RRF uses first appearance across the rankings. This makes output *deterministic*, which matters for reproducible evals and a UI that doesn't reshuffle. |

### Fusion concepts

| Term | Definition |
| --- | --- |
| **Hybrid search** | Running two retrievers with different failure modes — lexical (BM25, exact terms) and vector (embeddings, semantic similarity) — and combining their results. Each catches what the other misses. |
| **RRF** (Reciprocal Rank Fusion) | Combining ranked lists by **position**, not score: `score(id) = Σ 1 / (k + rank)`, rank 1-based. Cormack et al. (2009). |
| **Why by rank, not score** | BM25 scores are unbounded and corpus-relative; cosine similarities are bounded to `[−1, 1]`. There is no principled way to add them, and per-query normalisation is unstable on small result sets. RRF discards the incomparable magnitudes and keeps the only comparable thing — the ordering. This rationale is in the `rrf.ts` header. |
| **k** (smoothing constant) | Default 60. It flattens the value of rank position: large `k` compresses the gap between 1st and 10th, so **agreement between rankings** outweighs one ranking's strong opinion. At `k = 0` the top slot is worth 1.0 and position dominates instead. It is the single knob controlling that trade-off. |
| **Agreement vs. position** | The central tension RRF tunes. At `k = 60`, an id ranked 4th by *both* retrievers (`2/64 ≈ 0.031`) beats an id ranked 1st by *one* (`1/61 ≈ 0.016`). Consensus is treated as stronger evidence than a single confident vote. |
| **Convexity of `1/(k+r)`** | Because the curve is convex, spread-out placements beat clustered ones at the same rank sum: 1st + 3rd (`1/61 + 1/63`) narrowly exceeds 2nd + 2nd (`2/62`). Counter-intuitive, real, and tested. |

### Testing concepts

| Term | Definition |
| --- | --- |
| **Seam** | The public boundary a test observes behaviour through. This suite's seams are the five exported functions. Testing at a seam is what lets implementation change without touching tests. |
| **Oracle test** | A test whose expected value comes from an *independent* source of truth — a spec, a worked example, a known-good literal — rather than from the code. This suite has two: one per scoring module. |
| **Tautological test** | The failure mode an oracle avoids: the assertion recomputes the expected value the same way the code does, so it passes by construction and can never disagree with the implementation. |
| **Property test** | Asserts a relationship that must hold (`rare > common`) rather than an exact number. Survives parameter tuning; won't catch a uniformly-scaled error. |
| **Smoke test** | Confirms the pipeline runs end-to-end on real input without asserting quality. `emails.test.ts` is this. |
| **Eval** | Not a unit test. A scored benchmark measuring *quality* (relevance) over a labelled query set, where the answer is a number that can go up or down rather than pass/fail. `evalite` is installed and configured for exactly this and currently has zero suites. |

---

## 3. Test-by-test breakdown

Load-bearing rating:
🔴 **load-bearing** — pins a decision that is expensive to re-derive and whose
breakage is silent. Review these.
🟡 **guardrail** — catches real regressions, cheap to keep, low review priority.
⚪ **defensive** — proves an edge doesn't crash. Skim only.

### `tokenize.test.ts` (8)

The tokeniser runs at **both index time and query time**. Any change to it
changes what is findable across the entire corpus, and an index built with the
old rules silently mismatches queries tokenised with the new ones. This is why
so much of this small file is load-bearing.

| # | Test | Rating | What it pins |
| --- | --- | --- | --- |
| 1 | lowercases and splits on punctuation | 🟡 | Case-insensitive matching; hyphenated words split into parts. Note `nice-to-see-you` → `["nice","see"]` — `to` and `you` are stopwords. |
| 2 | keeps numbers | 🟡 | `45000` stays searchable. Matters for a corpus with amounts and dates. |
| 3 | drops tokens of length 1 | 🔴 | Defines a class of permanently unsearchable input. Single initials, "I", single digits. |
| 4 | drops stopwords | 🔴 | Same — the stopword list is a **recall policy**, and this test is the only place its effect is asserted. Growing the list shrinks what users can find. |
| 5 | preserves unicode, normalises NFKC | 🟡 | `Café` typed two different ways (precomposed vs combining accent) produces one token. Without this, half the corpus's accented names are unreachable from the other half's spelling. Subtle, and the assertion is easy to misread as duplicated — the two literals differ in bytes, not appearance. |
| 6 | email address as whole token **and** component words | 🔴 | A genuine product decision: `david.xu@firsthomemortgages.co.uk` is indexed both whole and as `david`, `xu`, `firsthomemortgages`, `co`, `uk`, so both the full address and "david xu" hit. This is the most intricate branch in `tokenize.ts` (the cursor/matchAll loop) and the most likely to break. |
| 7 | multiple addresses, order preserved | 🔴 | Guards the cursor arithmetic in that same loop — the case where slicing between matches can drop or duplicate surrounding text. |
| 8 | empty / punctuation-only input → `[]` | ⚪ | No crash, no empty-string tokens. |

### `bm25.test.ts` — "correctness" (11)

| # | Test | Rating | What it pins |
| --- | --- | --- | --- |
| 1 | only document containing a term ranks first | ⚪ | Baseline sanity. |
| 2 | rarer term outweighs common at equal tf | 🟡 | The **direction** of IDF. Would catch a sign flip or a swapped `df`/`N`. |
| 3 | prefers shorter document at `b = 0.75`, ties at `b = 0` | 🟡 | Length normalisation both works *and* is genuinely switched off by `b = 0`. The two-sided form is what makes it meaningful. |
| 4 | saturates term frequency | 🟡 | `10× > 1×` but `< 10 × 1×`. Catches a linear-tf regression, which is the single most common way to get BM25 wrong. |
| 5 | subject-only match beats body-only under email weights | 🔴 | The ranking policy users actually feel. If field weighting silently stops applying, results get worse in a way no other test detects. |
| 6 | `matchedTerms` reports only in-index query terms | 🟡 | Contract for UI highlighting: querying `mortgage advice unicorn` reports two matched terms, not three. |
| 7 | de-duplicates repeated query terms | 🟡 | `"mortgage mortgage"` scores the same as `"mortgage"`. Without it, users can inflate a term by repeating it. |
| 8 | **matches a hand-computed score on a toy corpus** | 🔴🔴 | The BM25 oracle, and one of the two most important tests in the repo. The only BM25 assertion tied to absolute numbers rather than relations. Everything else in the file could pass against a formula that is uniformly wrong; this could not. Review notes below. |
| 9 | tie-break by ascending document index | 🔴 | Determinism. Underpins reproducible evals and a stable UI ordering. Cheap to break by switching to an unstable sort or iterating a `Map` differently. |
| 10 | honours `limit`, defaults to 10 | 🟡 | Pagination contract. |

**Review notes on test 8.** It hand-computes `idf`, per-field length
normalisation, and the saturation step for two documents, then asserts to 6
decimal places. Worth checking specifically:

- The expected values are an *independent transcription of the BM25F spec*, not
  a call into the implementation — that's what makes it an oracle rather than a
  tautology. Verify the transcription against the formula in the header comment
  of `bm25.ts` and against Lucene's BM25, since a shared misunderstanding
  between doc-comment and test would go undetected.
- It hard-codes the *tokenised* form of each document in a comment
  (`d1 subject ["mortgage"](1)`) and derives average field lengths from it by
  hand. A tokeniser change silently invalidates those hand-derived constants,
  and the failure will look like a BM25 bug rather than a tokeniser one.
- `avgSubject = 1` and `avgBody = 5/3` are the numbers to check first if it ever
  goes red.

### `bm25.test.ts` — "edges" (7)

| # | Test | Rating | What it pins |
| --- | --- | --- | --- |
| 1 | empty / whitespace query → `[]` | ⚪ | |
| 2 | stopword-only query → `[]` | 🟡 | Documents the user-visible consequence of the stopword policy: searching `"the and of it"` legitimately finds nothing. Pairs with tokenize #4. |
| 3 | no query term in index → `[]` | ⚪ | |
| 4 | empty corpus doesn't divide by zero | ⚪ | `avgFieldLength` is 0 with no documents. |
| 5 | **IDF stays positive on a single-document corpus** | 🔴 | Pins the *choice of BM25 variant*. With `N = df = 1`, the classic Robertson IDF goes negative and a matching document scores below zero — then `minScore = 0` drops it and search returns nothing on small corpora. This test is the guard on that whole class of bug, and its one-line name badly undersells it. |
| 6 | document with an empty field | 🟡 | Confirms `b`-normalisation over a zero-length field yields finite scores, and that a weighted subject-only hit still outranks a body-only one. |
| 7 | `limit` larger than result count | ⚪ | |
| 8 | drops documents at or below `minScore` | ⚪ | Tested with `minScore: 1000`, i.e. only the "drops everything" extreme. |

### `rrf.test.ts` — "correctness" (5)

| # | Test | Rating | What it pins |
| --- | --- | --- | --- |
| 1 | **matches the hand-computed RRF score** | 🔴🔴 | The RRF oracle. Asserts `1/62 + 1/61` for an id placed 2nd and 1st, plus both single-ranking scores, to 9 decimals. Checks three things at once: the constant is 60, ranks are **1-based** (an off-by-one here is invisible in every ordering test but wrong everywhere), and contributions sum across rankings. |
| 2 | id in both rankings beats id in one | 🟡 | The direction of fusion, stated minimally. |
| 3 | **top-ranked id stays competitive when the other ranking misses it** | 🔴 | The behaviour that *justifies choosing RRF* for hybrid search: `mid` at 4th-and-4th (`2/64`) beats `lexical` at 1st-and-absent (`1/61`), while `lexical` still places 2nd rather than being buried. This is the agreement-vs-position trade-off made concrete, and it is entirely a function of `k = 60`. If `k` is ever tuned, this test is where the consequence shows up. |
| 4 | orders by descending fused score (convexity) | 🟡 | Asserts `["a","c","b"]` — 1st + 3rd narrowly beating 2nd + 2nd. Counter-intuitive and well-commented as deliberate. Its real value is defensive: it stops a future reader "fixing" a non-bug. |
| 5 | duplicate ids within one ranking score once, at best position | 🟡 | Input-hygiene contract. A retriever returning the same id twice can't double its own weight — the same class of defence as BM25's query-term de-duplication. |

### `rrf.test.ts` — "determinism" (2)

| # | Test | Rating | What it pins |
| --- | --- | --- | --- |
| 1 | **ties break by first appearance across rankings** | 🔴 | Load-bearing out of proportion to its size. The implementation gets this from two *implicit* language guarantees — `Map` preserves insertion order, and `Array.prototype.sort` is stable — neither of which is visible at the call site. Both are guaranteed by spec, so this test isn't guarding the engine; it's recording that the ordering is **intended** rather than incidental. Swap the `Map` for a plain object, or sort a differently-built array, and results reshuffle with nothing else failing. |
| 2 | identical input → identical output | ⚪ | Cheap restatement of purity. |

### `rrf.test.ts` — "the smoothing constant" (3)

| # | Test | Rating | What it pins |
| --- | --- | --- | --- |
| 1 | every score shrinks monotonically as `k` grows | 🟡 | Direction of the knob, with exact anchors (`1/11`, `1/101`). |
| 2 | gap between adjacent ranks flattens as `k` grows | 🔴 | This *is* the meaning of `k` — it's why a large `k` makes agreement outrank a single first place. Together with correctness #3 it fully documents the trade-off, which matters because `k = 60` is an inherited convention nobody here has yet validated against this corpus. |
| 3 | at `k = 0`, rank position dominates agreement | 🟡 | The opposite extreme: top slot is worth exactly 1.0, which two 3rd places cannot match. Bounds the knob from below. |

### `rrf.test.ts` — "edges" (7)

| # | Test | Rating | What it pins |
| --- | --- | --- | --- |
| 1 | **one empty ranking → other ranking's order survives** | 🔴 | The production failure mode, not a toy edge. If the embedding call fails, returns nothing, or the vector index hasn't been built, hybrid search must **degrade to pure lexical** rather than returning nothing. This test is the entire graceful-degradation guarantee. |
| 2 | all rankings empty → `[]` | ⚪ | |
| 3 | no rankings at all → `[]` | ⚪ | |
| 4 | single ranking preserves order | 🟡 | Fusion of one is the identity. Also the shape of the fallback path above. |
| 5 | fuses more than two rankings | 🟡 | The signature takes `string[][]`, so a third retriever needs no code change. Worth keeping when that lands. |
| 6 | honours `limit` | 🟡 | |
| 7 | `limit` beyond candidate count | ⚪ | |

### `emails.test.ts` (3)

| # | Test | Rating | What it pins |
| --- | --- | --- | --- |
| 1 | reads the whole corpus once | 🔴 | Two assertions doing different jobs. `getAllEmails() === getAllEmails()` is a **performance contract**: the module-level memo must hold, or every request re-reads and re-indexes 500+ emails. Breakage is invisible in correctness terms and shows up only as latency. `length > 500` catches a truncated or failed corpus load. (Until issue #6 this asserted on `getEmailIndex()`; the index moved to the document layer, which memoises it per source set.) |
| 2 | mortgage thread in top 3 for "mortgage pre-approval" | 🟡 | The only end-to-end test: real JSON → real tokeniser → real index → real ranker. Asserted loosely and labelled as such in a comment. It proves the pipeline is *connected*, not that ranking is *good*. |
| 3 | nonsense query → `[]` | ⚪ | |

The file has since grown to 9 tests, adding conceptual queries answered through
the vector leg, the duplicate-notification crowding guard, and lexical-only
fallback when the embedder throws. The three above are still the ones worth
review time. Since issue #6 it is also the **relevance regression net**: it drives
the whole hybrid pipeline through `searchEmails`, so a refactor of identity that
moved results would fail here.

### `documents.test.ts` (17)

Cross-source behaviour at the one new public seam, `searchDocuments`. No second
real corpus and no mocks: `sources` is a parameter, so the tests pass tiny
in-memory fakes the way `bm25.test.ts` passes inline documents.

| # | Test | Rating | What it pins |
| --- | --- | --- | --- |
| 1 | two sources minting the same native id stay two documents | 🔴 | The reason ids are namespaced at all. Its failure mode is one document silently shadowing another — a wrong result, not an error. |
| 2 | a reserved character in a native id throws, naming the id | 🔴 | The other silent failure: a malformed id parses back into a different id, misses every lookup, and drops the document from all results. |
| 3 | a source with no native ids gets stable content-derived ones | 🟡 | The hash fallback, asserted as *behaviour* — same content, same id across builds; different content, different id — never as a hash value. |
| 4 | a chunked document collapses to one result | 🟡 | Best-chunk-wins, now generic rather than email-specific. |
| 5 | a rejecting embedder degrades to lexical-only | 🔴 | The graceful-degradation guarantee, at the layer that now owns it. |
| 6 | sources disagreeing on a field weight are refused | 🟡 | A merged index has one weight per field name; a silent overwrite would retune ranking by accident. |
| 7 | a source minting one id for two documents is refused | 🔴 | The hashed-id path can collide, and the collision would otherwise be a lost document rather than an error. |
| 8 | a vector for a chunk the source does not have is refused | 🔴 | An artifact that has drifted from the chunking policy, caught loudly instead of ranking over half a corpus. |
| 9 | a set of sources is indexed once however many queries run | 🔴 | The performance contract the deleted `emails.test.ts` memo tests used to hold: without it every query re-reads the corpus and rebuilds both indexes, invisibly. Counts `all()` invocations on an injected fake — the one place this suite counts calls, because the failure is latency and not a wrong answer. |
| 10 | the source filter is applied before the limit | 🟡 | `searchEmails({ limit: 5 })` must mean five emails, not five documents of which some are emails. |
| 11 | no vectors anywhere → no embedding round-trip | 🟡 | Cost and latency, invisible in the result. |
| 12–17 | source labelling, semantic ranking with fake vectors, empty query, `getDocument` routing and unknown-source error | ⚪ | |

Nothing here asserts on the id format itself. The `:` and `#` conventions should
be replaceable without touching this file.

### `email-search-tool.test.ts` (10)

The seam the chat model reaches search through. Tests build the tool with an
injected embedder and call `execute` directly with typed arguments — no live
model, no `Request`, no network. This is the highest seam testable without
mock-model infrastructure the repo does not have.

The split of assertion styles is the thing to notice: relevance is asserted
**loosely** (same spirit as `emails.test.ts` — it proves the tool is wired to the
ranker, not that ranking is good), while the payload contract is asserted
**exactly**, because those are bounds the route and the model depend on rather
than knobs anyone intends to tune.

| # | Test | Rating | What it pins |
| --- | --- | --- | --- |
| 1 | returns emails recognisably on topic | 🟡 | The pipeline is connected: real corpus → real tokeniser → BM25F + semantic → RRF → tool payload. Smoke test, labelled as such. |
| 2 | nonsense query → `[]` | 🔴 | "Nothing found" is a legitimate answer the model must be able to give. If this ever returns padding, the model will confidently answer from five irrelevant emails — the failure mode that actually matters here, and worse than silence. |
| 3 | broad query caps at 5 | 🔴 | The payload bound. Caps worst-case context spend and cost per turn; `EMAIL_SEARCH_RESULT_COUNT` is the one constant to raise, and only with an eval that says raising it helped. |
| 4 | narrow query returns fewer than 5 | 🟡 | The cap is a ceiling, not a target. Uses `deansgate`, which occurs in exactly one email. |
| 5 | bodies truncated to the budget | 🔴 | The other half of the payload bound — the corpus's longest body is ~6600 characters, so five untruncated results could dominate the context window alone. Two-sided: every body is within budget **and** at least one actually reaches it, or the assertion is vacuous. |
| 6 | exactly the documented fields, no score | 🔴 | The output contract, asserted as an exact key set. The fused RRF score is deliberately absent: it has no absolute meaning and inviting the model to reason about it invites nonsense. Adding a field silently changes what the model is being asked to read. |
| 7 | embedder failure still yields lexical results | 🔴 | The graceful-degradation guarantee, pinned at the seam users actually reach. `rrf.test.ts`'s "one empty ranking" test pins the same guarantee one level down. An embedding outage degrades the assistant's results; it does not break chat. |
| 8–10 | schema accepts a query, rejects missing, rejects empty | 🟡 | A bad call is refused by the Zod schema rather than reaching the ranker. |

### `src/app/api/chat/tools.test.ts` (3)

**The one test above the search layer, and a deliberate exception** rather than
the thin end of a wedge toward route testing. It exists because the defect it
guards ships green and surfaces a day later in a user's face.

Persisted tool parts are replayed to `/api/chat` on the *next* request. If
`safeValidateUIMessages` rejects that history, the failure lands not on the turn
that searched but on the one after it, as a 400 and an unusable chat. Testing it
needs no route infrastructure: `safeValidateUIMessages` is an async pure
function, so the test hand-writes the message and calls it.

The tool registry lives in `tools.ts` rather than `route.ts` specifically so this
test can import it without dragging the route and the persistence layer along.

| # | Test | Rating | What it pins |
| --- | --- | --- | --- |
| 1 | a persisted tool part validates | 🔴 | The main guarantee: a chat that has searched once can be continued. |
| 2 | a malformed tool input is rejected | 🔴 | What makes #1 non-vacuous. **Note the surprise here:** in `ai@5.0.113`, *omitting* `tools` does not reject a tool part — it skips tool-part validation entirely and the message passes unchecked. So the argument's job is to make persisted tool parts *checked*, not merely *accepted*. This test is what states that, and what stops the argument being deleted as decorative. |
| 3 | an unregistered tool name is rejected | 🟡 | The consequence of turning that validation on, recorded on purpose: renaming or removing the tool breaks every chat that used it, because persisted history outlives the tool registry. |

---

## 4. The load-bearing set, in review order

If you review nothing else, review these nine:

1. **`bm25.test.ts` — "matches a hand-computed score on a toy corpus"** — the
   BM25 oracle. Everything else in that file is relational and could pass
   against a uniformly wrong formula. Check the arithmetic and the hand-derived
   token lists.
2. **`rrf.test.ts` — "matches the hand-computed RRF score"** — the RRF oracle,
   and the only test pinning that ranks are 1-based. An off-by-one there changes
   every fused score while leaving every ordering assertion green.
3. **`bm25.test.ts` — "keeps IDF positive on a single-document corpus"** — its
   name undersells it. Pins the choice of BM25 variant and guards a bug class
   that makes search silently return nothing on small corpora.
4. **`rrf.test.ts` — "degrades to the other ranking's order when one is empty"**
   — the graceful-degradation guarantee for hybrid search. When embeddings fail,
   this is what keeps lexical results flowing.
5. **`rrf.test.ts` — "keeps a top-ranked id competitive"** + **"flattens the gap
   as k grows"** — read as a pair. Together they define the agreement-vs-position
   trade-off that `k = 60` buys, which is the main thing to validate once hybrid
   search is actually wired up.
6. **`tokenize.test.ts` — the two email-address tests** — the most intricate code
   path in the tokeniser, and tokenisation changes invalidate the index.
7. **`tokenize.test.ts` — stopwords and length-1 tokens** — the recall policy.
   Anything on those lists is permanently unfindable.
8. **`bm25.test.ts` — "subject-only above body-only under email field weights"**
   — the ranking decision users actually feel.
9. **`emails.test.ts` — "indexes the whole corpus once"** — a performance
   contract whose breakage is invisible to every other test.

Plus the two **determinism** tie-break tests (BM25 by document index, RRF by
first appearance) if reproducible evals matter to you — non-determinism makes
eval scores move for reasons unrelated to ranking. The RRF one is the more
fragile of the two, since it rests on `Map` iteration order and sort stability
rather than on anything explicit in the code.

---

## 5. Gaps worth deciding about

Listed as findings, not recommendations — the scoping calls are yours.

1. **No evals exist.** `evalite` is a dependency, `evalite.config.ts` is wired to
   the vitest config, and there are zero `*.eval.ts` files. `emails.ts` ("a
   starting guess to tune against evals"), `docs/bm25-search.md`, and now `k = 60`
   in `rrf.ts` all defer the *actual quality questions* — field weights, no
   stemming, `k1`/`b`, and the fusion constant — to a harness that does not
   exist. The unit tests prove the maths is BM25 and RRF; nothing measures
   whether the results are good. This is the largest gap by some distance, and
   RRF has just made it larger by adding a knob.

2. **`fuseRRF` has no callers and no integration test.** Every test feeds it
   hand-written `string[][]`. Nothing yet checks that `searchBM25` output
   actually maps onto that shape, that ids line up between the lexical and vector
   sides, or that the vector ranking produced by
   `scripts/build-email-vectors.ts` is ordered best-first — which RRF assumes
   without being able to verify. The unit is well covered; the seam where it will
   be *used* is entirely uncovered. That seam is where hybrid search will
   actually break.

3. **`limit` behaviour is inconsistent between the two rankers.** `searchBM25`
   defaults `limit` to 10; `fuseRRF` returns everything when `limit` is omitted.
   Defensible — fusion shouldn't truncate before the caller decides — but it's an
   asymmetry a caller will get wrong eventually, and no test documents the
   contrast.

4. **`emails.ts` is only partly covered.** The disk read and `JSON.parse` have no
   test for malformed or missing input, and the `flatMap` branch that drops a
   result whose id isn't in the by-id map is unreachable in practice and
   unexercised — so if the index and the map ever diverge, results vanish
   silently rather than failing loudly.

5. **`minScore` is only tested at an extreme.** The default is `0` with a strict
   `>` filter, so a zero-scoring document is dropped. That boundary — the one
   that actually runs on every query — has no test; only `minScore: 1000` does.

6. **Almost nothing above the search layer is tested.** `src/app/api/chat/route.ts`,
   the `useChat` UI, and `src/lib/persistence-layer.ts` have no coverage; the
   sole exception is `tools.test.ts`, which covers message validation only. For
   the route and UI this is a defensible choice; `persistence-layer.ts` is worth
   a second look, since its read-modify-write save path is last-write-wins with
   no locking, and data-loss bugs are also the silent kind.

7. **Nothing measures the queries the model writes.** The tool hands query-writing
   to an LLM, but every tuning decision in the search layer — the stopword list,
   the absent stemmer, the field weights, `k = 60` — was made against queries a
   human typed. LLM queries are longer and more prose-like, and those choices
   will bite differently there. This is the first thing an eval suite should
   measure, and it is entirely unmeasured today.

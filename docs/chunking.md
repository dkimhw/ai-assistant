# Chunking

How emails become the texts we embed, what the alternatives were, and why this
corpus got the policy it did.

Implementation: `src/lib/search/email-chunks.ts`, reached through
`emailSource.chunk`. Query-time collapse back to documents:
`src/lib/search/documents.ts`. The decision summary lives in
[`hybrid-search.md`](./hybrid-search.md); this document is the reasoning behind
that one line in its decision table.

## What chunking is for

An embedding is one fixed-length vector, so whatever text you hand it gets
averaged into a single point. That gives two failure modes pulling in opposite
directions:

- **Chunks too large** — a 3,000-word email about a mortgage, a holiday and a
  dentist appointment produces a vector that is close to none of them. Its
  distinctive parts are diluted by everything around them.
- **Chunks too small** — a single sentence loses the context that made it
  meaningful ("yes, that works for me" — what does?), and the index fills with
  fragments that match a query without answering it.

Chunking is the choice of where to sit between those. It is also, unavoidably,
corpus-specific: the right answer for 500-word emails is not the right answer
for 80-page PDFs. That is why it lives on the adapter side of the boundary, with
the ranker seeing only vectors — and, since issue #6, why it is *selectable per
source*: `chunk` is a function on `DocumentSource`, so a future source of long
PDFs chunks differently from email without forking anything. The document layer
calls it and never looks at what comes back except to collapse it.

## The strategies

### 1. Whole document, one vector

Embed each email as a single text, no splitting.

| | |
| --- | --- |
| **Pros** | Simplest possible thing. One vector per email means no collapse step, no duplicate-parent logic, no chunk-id scheme. Retrieval unit matches display unit exactly. Cheapest to build and smallest artifact. |
| **Cons** | Dilution on long documents. A long email covering several topics is retrievable by none of them well. Fails badly the moment the corpus contains newsletters, contracts or long threads. |
| **Fits** | Corpora where documents are short and single-topic — which is most email. |

### 2. Fixed-size character or token windows

Cut every N characters (or tokens), typically with a fixed overlap.

| | |
| --- | --- |
| **Pros** | Trivially predictable: uniform vector count, uniform cost, uniform chunk length so no chunk's vector is diluted more than another's. No parsing, no format assumptions, works on anything. |
| **Cons** | Cuts mid-sentence and mid-word. A boundary landing in the middle of the one paragraph that answers the query splits the answer across two vectors, each a weak match. Overlap mitigates but does not fix it, and costs storage proportional to the overlap. |
| **Fits** | Heterogeneous or unstructured text where you cannot rely on any structure existing. |

### 3. Structural / recursive splitting

Split on the document's own boundaries — paragraphs, then sentences, then
characters — packing units together up to a size budget.

| | |
| --- | --- |
| **Pros** | Boundaries fall where the author already put them, so chunks are coherent units of thought. Roughly as cheap as fixed windows. Degrades gracefully: an unstructured blob falls through to the fixed-window behaviour. |
| **Cons** | Chunk sizes are uneven — a document of one 4,000-character paragraph is not helped at all. Depends on the structure being real; text pasted from a PDF with hard-wrapped lines has paragraph markers that mean nothing. |
| **Fits** | Prose written by people: email bodies, docs, articles. |

### 4. Semantic chunking

Embed sentences individually, then cut where consecutive-sentence similarity
drops — boundaries follow topic shifts rather than punctuation.

| | |
| --- | --- |
| **Pros** | Boundaries track meaning, which is what the vectors are meant to capture. Handles the long-single-paragraph case that structural splitting cannot. |
| **Cons** | Needs an embedding pass over every sentence *before* the chunking pass — several times the build cost and a much slower build. Introduces a similarity threshold that itself needs tuning, and the tuning needs an evaluation harness. Benefits show up mainly on long, topically-mixed documents. |
| **Fits** | Long-form documents where the payoff justifies the build pipeline. |

### 5. Contextual / augmented chunks

Prepend context to each chunk — the document title, a breadcrumb, or an
LLM-generated summary of how the chunk fits the whole.

| | |
| --- | --- |
| **Pros** | Directly attacks the lost-context failure of small chunks. Cheap and very effective in its lightweight form (prepend the title). Meaningfully improves recall in published results. |
| **Cons** | The LLM-generated form costs a model call per chunk at build time and drifts as the model changes. Any augmentation eats part of the vector's capacity, so overdoing it dilutes exactly what it set out to sharpen. |
| **Fits** | Any chunked corpus — the title-prepend variant is close to free. |

### 6. Hierarchical / parent-document retrieval

Index small chunks for precision, but return (or re-rank on) the larger parent.

| | |
| --- | --- |
| **Pros** | Precision of small chunks with the context of large ones. Small chunks match tightly; the user still sees a whole document. |
| **Cons** | Two levels of state to keep consistent, and a collapse policy to define — best chunk, sum of chunks, or count of chunks, each ranking differently. |
| **Fits** | Corpora with a real hierarchy, and any system whose display unit is bigger than its match unit. |

### 7. No chunking, field-level embedding

Embed each field (subject, body, …) as its own vector and combine at query time.

| | |
| --- | --- |
| **Pros** | Mirrors the BM25F field-weighting model, so both rankers reason about the same structure. Field weights become tunable in the semantic leg too. |
| **Cons** | Multiplies vector count by field count, mostly on fields with little semantic content. Introduces a second weighting scheme to tune before it pays for itself, and still does nothing about a long body. |
| **Fits** | Corpora with several genuinely contentful fields of comparable length. |

## What we do

For each email, in order:

1. **Strip quoted reply text** — `>` lines, Gmail/Apple attribution, the Outlook
   separator, forwarded-header blocks. 13 of 547 emails affected.
2. **Prepend the subject** to the body (strategy 5, in its cheap form).
3. **Exclude sender and recipient addresses.**
4. **Split bodies over 1,500 characters** on paragraph boundaries into
   ~1,200-character chunks with one paragraph of overlap (strategy 3), leaving
   everything shorter whole (strategy 1). 16 of 547 emails qualify.
5. **Collapse chunks to their parent document** at query time, each document
   taking its best-scoring chunk (strategy 6). Chunk ids are `${documentId}#${n}`
   and the collapse is the exact inverse of that formatting, both owned by
   `document-id.ts`.

547 emails → 606 chunks → 463 indexed vectors, after one-vote-per-distinct-text
deduplication.

## Why this one

**The corpus decided it.** Character distribution: median 434, p90 730, max
6,660. 531 of 547 emails are under the threshold and get exactly one vector — so
the dominant strategy here is really *whole document*, with structural splitting
as the escape hatch for the 3% that need it. Building a uniform fixed-window
pipeline would have chopped 97% of the corpus for the benefit of the other 3%.

**Quote stripping mattered more than chunk size.** Every message in a thread
quotes its history. Left in, a five-message thread produces five near-identical
vectors, and one conversation takes the whole result page. This is a bigger
retrieval effect than any boundary choice, and it is pure email knowledge — no
generic chunker would have known to do it.

**Paragraphs over fixed windows** because these are human-written prose bodies
where paragraph breaks are real. The cost of respecting them is a few lines of
code and uneven chunk sizes we do not care about at this scale.

**Subject prepending over field-level embedding** because it buys the same
thread context for zero extra vectors, and it keeps the semantic leg's
structural assumptions identical to the lexical index's, where `subject` already
outweighs `body` 3:1.

**Addresses excluded** because they are lexical signal. `sarah.chen@example.com`
has no meaning to embed; BM25F already handles identifiers exactly right, and
putting them in the vector spends capacity to make the ranking worse.

**Semantic chunking rejected on cost/benefit,** not on principle. It would need
an embedding pass over every sentence in the corpus and a similarity threshold
to tune, to improve the handling of 16 emails. Revisit if the corpus grows a
long-document population.

**Best-chunk collapse, not sum,** because summing rewards length: a long email
with five weakly-matching chunks would outrank a short one that is exactly the
answer. The best chunk is the strongest evidence the email is relevant, and
using it keeps the score comparable between a 1-chunk and a 6-chunk email.

## Known weaknesses

| Weakness | Effect | Trigger to revisit |
| --- | --- | --- |
| The 1,500-character threshold is set from the corpus's character distribution, not from measured retrieval quality | Unknown; plausibly fine, but unverified | An evaluation harness exists |
| Quote stripping is a heuristic over client conventions | A miss reintroduces thread clustering | A new mail client's convention appears in the corpus |
| One 4,000-character paragraph is not split at all | That email keeps one diluted vector | A corpus with long unbroken prose |
| Overlap is one paragraph, so it varies with paragraph length | A very long paragraph of overlap wastes index space | Chunk counts grow out of proportion to corpus size |

All of these want the relevance evaluation harness that does not exist yet — as
do the cosine floor and the BM25F field weights. Tuning chunk size against
measured quality without one is guessing with extra steps.

# Reranked email search, with conversation context

## Problem Statement

When I ask the assistant a question about my email, it searches once and answers
from the top five results of a fused BM25F + semantic ranking. Two things go
wrong from where I sit.

First, the right email is often in the results but not at the top, and the
assistant answers from whichever email happened to rank first. Worse, on a long
email the assistant only ever reads the first 1,200 characters of the body — so
when the answer is in the fourth paragraph of a long lender email, it is simply
not in front of the model, even though the search layer already found and
embedded exactly that passage as a chunk. I get "I couldn't find that" about
information that is demonstrably in my inbox.

Second, the assistant has no memory of the conversation when it searches. I ask
"what did the broker say about the rate lock?", get an answer, and then ask "and
what was the deadline on that?" — the follow-up is searched and ranked as if it
arrived out of nowhere. Results come back that are about deadlines in general
rather than the deadline in the email we were just discussing, and I have to
repeat the context I already gave.

## Solution

Add a reranking stage to the search the assistant performs, and give that stage
the recent conversation as context.

When the assistant calls the email search tool, the hybrid ranker now fetches a
deeper pool of candidates than before — roughly twenty-five emails rather than
five — and a reranker reads the actual chunk text of those candidates against
the query and the last few turns of conversation. It returns the five best, in
its order, and each result carries the *winning chunk* rather than the opening
of the email. The assistant reads the passage that actually matched.

Because the reranker sees the recent conversation, a follow-up like "and what
was the deadline on that?" is judged in context: the email we were just talking
about wins, rather than any email that mentions a deadline. Only the human turns
of the conversation are shared — the user's messages and the assistant's prose
replies. Previous tool calls and their results are deliberately excluded: they
are bulky, they are already summarised by the assistant's reply, and feeding a
retrieval system its own previous retrievals is how a conversation gets stuck in
one neighbourhood of the corpus.

Nothing changes on the email search page. It keeps today's ordering, today's
cost, and today's pagination behaviour.

If the reranker is unavailable or errors, search degrades to the fused ordering
it produces today: a provider outage costs relevance, not the feature.

## User Stories

1. As someone asking about my email, I want the assistant to read the passage of
   an email that actually matched my question, so that the answer is not missed
   because it sat below the first 1,200 characters.
2. As someone asking about my email, I want the most relevant email of the
   candidates to be first, so that the assistant's answer is drawn from the right
   message.
3. As someone asking about my email, I want the search to consider more than five
   candidate emails before deciding what to show, so that a slightly mis-phrased
   query does not push the answer out of reach.
4. As someone asking a follow-up question, I want the assistant to interpret it in
   the context of what we were just discussing, so that I do not have to restate
   the subject every time.
5. As someone asking a follow-up with a pronoun ("that one", "the second email"),
   I want the results to be ranked against what those words refer to, so that
   short, natural questions work.
6. As someone asking about my email, I want previous tool results kept out of the
   context sent to the reranker, so that the ranking is not anchored to the emails
   an earlier search already returned.
7. As someone with a long conversation, I want only the most recent few turns used
   as context, so that a question about a new topic is not dragged back toward the
   old one.
8. As someone asking about my email, I want the assistant to still answer when the
   reranking provider is down, so that an outage means slightly worse ordering
   rather than a broken assistant.
9. As someone asking about my email, I want the assistant to still say "I could
   not find that" when nothing matches, so that reranking never manufactures a
   confident answer out of five irrelevant emails.
10. As someone asking about my email, I want the assistant to cite the sender and
    subject of the emails it used, exactly as it does today, so that reranking
    does not change how I verify an answer.
11. As someone asking about my email, I want the number of results the assistant
    receives to stay fixed and small, so that a turn stays cheap and the assistant
    actually reads what it is given.
12. As someone using the email search page, I want its results and its speed
    unchanged, so that a feature aimed at the assistant does not slow down
    browsing.
13. As someone using the email search page, I want pagination to keep working
    over the whole corpus, so that reranking's bounded candidate pool does not
    silently truncate what I can page through.
14. As someone watching the assistant work, I want the collapsible search block to
    show the passage the assistant actually read, so that I can see why it
    answered the way it did.
15. As a developer, I want the reranker expressed as an injectable interface, so
    that swapping the LLM implementation for a dedicated cross-encoder later is
    one new implementation and no pipeline changes.
16. As a developer, I want the reranker off by default at the document layer, so
    that a caller pays for a model call only by asking for one.
17. As a developer, I want the tool's tests to run offline against the real
    corpus with a fake reranker, so that relevance wiring is covered without a
    network call.
18. As a developer, I want to assert exactly which conversation turns reach the
    reranker, so that the "no tool history" rule is enforced by a test rather than
    by a comment.
19. As a developer, I want the reranker's failure path covered by a test, so that
    the degradation promise is real.
20. As a developer, I want the chunk-level reranking behaviour observable over
    fake sources at the document layer, so that it is not only testable through
    the email corpus.
21. As a developer, I want the rerank stage to live where chunk text already
    exists, so that chunking knowledge does not get duplicated outside the source
    adapter.
22. As a developer, I want the candidate pool size, result count, and history
    depth to be named constants with stated rationale, so that tuning them later
    is an informed edit rather than a guess.
23. As someone paying for this, I want exactly one additional model call per
    search, so that the cost of the feature is predictable.
24. As someone asking a first question in a new chat, I want search to work with
    no conversation history at all, so that the very first turn is not a special
    case that fails.

## Implementation Decisions

### A reranker interface, mirroring the embedder

- A new search module defines a `Reranker` type in the same spirit as `Embedder`:
  a named model plus one method that takes a query, an optional conversation
  context, and a list of candidate passages, and returns them scored or ordered.
  Candidates are identified by opaque id and carry only text — the reranker,
  like every other ranker in this codebase, knows nothing about emails.
- One implementation ships, using the OpenAI model already configured for this
  project (the small/nano tier used for titles). No new dependency, no new
  provider, no second API key.
- The implementation is resolved lazily at the call site, exactly as
  `createOpenAIEmbedder` is, so an unset API key is an error at search time
  rather than at import time.
- A dedicated cross-encoder (Cohere, Voyage) is explicitly the anticipated
  successor. The interface exists so that swap is a new implementation and a
  config change.

### The rerank stage lives in the document layer, opt-in

- `searchDocuments` grows an optional rerank stage that runs after RRF fusion.
  It is where chunk ids and chunk text already exist, so no chunking knowledge
  leaks into a caller.
- The stage is off unless the caller passes a reranker. The email search page
  does not pass one and is behaviourally unchanged; the chat tool does.
- The reranker is injectable on `searchDocuments` for the same reason `sources`
  and `embedder` are: tests pass a fake and never hit the network.
- When reranking is on, the fused candidate pool is deepened to roughly
  twenty-five documents before the limit is applied, so the reranker has real
  material to reorder rather than being handed the same five it would return.
- The stage reranks *chunks*, then collapses to documents taking each document's
  best chunk — the same collapse the semantic leg already performs. This matters
  on the sixteen long emails in the corpus and is a no-op on the rest.
- A result gains the winning chunk's text and id. The existing fused `score` keeps
  its current meaning (an ordering signal with no absolute value); the rerank
  score is not exposed to callers, because a caller that reasons about it will
  reason about it wrongly and the ordering already encodes it.
- Rerank failure is caught, logged with a warning, and the fused ordering is
  returned — the same contract as the embedder fallback. A stale vector artifact
  keeps throwing; that distinction is unchanged.

### The tool returns passages, not body prefixes

- The email search tool's result shape changes: the per-result body prefix is
  replaced by the winning chunk's text. The chunk already has quoted reply text
  stripped and the subject prepended by the email chunking policy, so a result is
  a self-contained passage.
- For the great majority of the corpus a single chunk *is* the whole email, so in
  practice this changes what the assistant sees mainly on long messages — which is
  exactly the case it is meant to fix.
- A character budget per result is retained as a hard bound, so a result can never
  exceed a known size regardless of how chunking policy evolves.
- The result count stays fixed at five and stays out of the tool's input schema.
  The model does not choose it.
- The tool's field set stays otherwise identical — id, subject, sender,
  timestamp — so citation behaviour and the system prompt need no change.
- The chat UI's collapsible tool block renders the passage in place of the body
  prefix. Same component, same shape, different text.

### Conversation history reaches the tool through the SDK's execute options

- The tool's `execute` already receives the current step's model messages from the
  AI SDK. The tool reads history from there; the route and the module-level
  `chatTools` constant are unchanged, and no per-request tool factory is
  introduced.
- The tool filters that history down to text from user and assistant messages
  only. Tool calls, tool results, and this turn's own retrieval traffic are
  dropped. This is the "don't pass tool call convo history" rule and it lives in
  one place.
- Roughly the last three turns are kept, most recent last, bounded by a named
  constant. Enough to resolve "that one" and "the deadline on that"; short enough
  that a rerank prompt cannot grow with the length of the chat, and that a change
  of subject is not dragged back to the previous one.
- History is passed to the reranker as context and nowhere else. The BM25F and
  semantic legs continue to see only the model-written query — query rewriting
  before retrieval is a separate, later decision.
- An empty history (a brand-new chat, or a caller that supplies none) is a normal
  case, not an error: the reranker judges on the query alone.

### Constants and rationale

- Candidate pool for reranking, result count, history turn depth, and the
  per-result character budget are each named constants carrying a one-line
  rationale, in the same style as the existing search constants. The pool depth
  and history depth in particular are starting positions to tune against evals,
  not claims.

## Testing Decisions

A good test here asserts what a caller can observe: the payload a tool call
returns, the order of results, what the reranker was asked, and what happens when
a provider fails. It does not assert prompt strings, internal call counts, or the
shape of anything the reranker is handed beyond its documented contract.
Relevance assertions stay loose — smoke tests that prove the wiring is real over
the real corpus — because tight relevance assertions are how a ranker becomes
untunable. Fakes are injected at existing seams; no module mocking.

Two seams, both already in place and each extended by one injectable.

**Seam 1 — the email search tool.** Built with an injected embedder and an
injected reranker, then called through `execute` with the same typed arguments a
model would supply. Its existing test file already passes a `messages` array into
`execute`, so conversation-history behaviour is assertable with no new hook. This
seam covers:

- the winning passage is what comes back, not a body prefix
- the per-result character bound holds, and is actually reached by some result
- the documented field set exactly, with no rerank score leaking out
- the fixed result cap, and that fewer matches means fewer results rather than
  padding
- the reranker receives the user and assistant text of the recent turns
- the reranker receives *no* tool calls or tool results
- history is truncated to the documented depth
- an empty history is handled without error
- a failing reranker still yields sensible lexical/fused results
- a failing embedder *and* a working reranker still yields results

Prior art: the tool's existing tests, which use a fixture embedder backed by
committed query vectors and an "offline" embedder that throws. A fake reranker
follows the same two patterns — one that reorders deterministically so ordering
is assertable, one that throws.

**Seam 2 — `searchDocuments`.** Over fake sources, as the document-layer tests
already do. This seam covers:

- passing a reranker reorders results away from the fused order
- omitting a reranker leaves today's behaviour byte-for-byte unchanged
- the winning chunk is the one returned, for a document with several chunks
- documents are still collapsed one-per-result after chunk reranking
- the deeper candidate pool is used when reranking is on
- a throwing reranker falls back to the fused ordering

Prior art: the existing document-layer tests, which inject `sources` and
`embedder` fakes for exactly this reason.

The OpenAI reranker implementation itself is not unit tested, consistent with
`createOpenAIEmbedder` today: it is a thin provider adapter, and a test of it
would be a test of the SDK.

The conversation-history filter gets no seam of its own. It is observed through
the tool seam, which keeps the number of seams at two.

## Out of Scope

- **The email search page.** No reranking, no cost change, no ordering change.
- **Query rewriting.** History informs reranking only. Resolving a follow-up into
  a standalone query *before* retrieval fixes recall rather than ordering and is a
  separate piece of work with its own failure modes.
- **A dedicated cross-encoder provider.** The interface anticipates it; this work
  does not add a dependency or a second API key.
- **Relevance evals.** `evalite` is installed and configured with no suites. A
  fused-versus-reranked comparison is the obvious first suite and the right way to
  tune the pool depth, history depth, and field weights — but it is not part of
  this spec.
- **Caching rerank results.** Per-query or per-conversation caching is a later
  optimisation.
- **Changing the field weights, the chunking policy, or the vector artifact.**
  Untouched; no rebuild of vectors is required by this work.
- **The system prompt's retrieval rules.** The tool's contract is unchanged from
  the model's point of view apart from richer passages, so the prompt does not
  need to move.
- **Multi-source reranking concerns.** Email is still the only registered source;
  cross-source rerank calibration is a problem for when a second one lands.

## Further Notes

- The corpus is small — 547 emails, 606 chunks, and 531 emails fitting in a single
  chunk — so the passage change bites on roughly sixteen long messages. Those are
  disproportionately the lender and paperwork emails where detail is buried, which
  is where the reported failure comes from.
- 143 of the 606 chunks are exact duplicates. The semantic leg already
  deduplicates them per source; the reranker will occasionally be handed near
  duplicates through the lexical leg. Acceptable — reranking near-identical
  passages is harmless, just mildly wasteful.
- Latency: one additional model call per tool call, on a turn that already makes
  an embedding call and at least two chat completions. With a step limit of five
  in the chat loop, the worst case is bounded.
- The known BM25F limitation recorded on the source registry — pooled field-length
  statistics across sources — is untouched and still waiting on a real second
  source.
- Tuning order once evals exist: candidate pool depth first (it bounds what
  reranking can possibly fix), then history depth, then the field weights.

---

*No issue tracker is configured for this repo — the triage label vocabulary was
never provided — so this spec is saved locally rather than published. Run
`/setup-matt-pocock-skills` to wire one up, then it can be filed with the
`ready-for-agent` label.*

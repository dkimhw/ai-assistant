# History snippets anchor on the wrong term

Status: **fixed** on `fix/history-snippet-anchor`, by the second option below.
Kept as the record of why the anchor is what it is. Found by review of `e2443ec`
(Phase 4 of `plans/window-and-backlog.md`); the `searchHistory` tool it affects
had already shipped.

## Problem statement

A `searchHistory` hit can come back without the words it matched on.

`snippet` in `src/lib/search/chat-history.ts` cuts a long message down to a
600-character window around the term that matched. Which term it anchors on is
decided by this line:

```ts
const at = positions.length > 0 ? Math.min(...positions) : 0;
```

That is the *earliest* matched term in the message, not the most informative
one. When a common query word appears near the top of a long message and the
discriminating word appears far down, the window is cut around the common word
and the answer is left outside it.

Reproduced against the shipped code. A pasted document of the shape:

```
Date: 3 March 2026. Minutes of the meeting. <~1500 characters of filler>
the completion date is 14 March
```

queried with `completion date`, returns a snippet beginning:

```
"Date: 3 March 2026. Minutes of the meeting. lorem ipsum lorem ipsum lorem…"
```

and `text.includes("completion date is 14 March")` is `false`. The message ranked
first — the retrieval was right — and the passage handed to the model contains
nothing about a completion date.

## Why it matters

This is the failure `snippet`'s own docblock is written against, and the example
it names is the one above. It reached production anyway because the fix it
describes solved the *previous* version of the bug rather than this one: Phase 3
returned the first 600 characters of a message, review caught that, and the
repair moved the anchor from "the opening" to "the first match" without asking
whether the first match is the right one.

The consequence is worse than an empty result. The model is told a message
matched, reads a passage with nothing relevant in it, and has two ways to be
wrong: restate the irrelevant passage as though it answered the question, or
conclude the search failed and tell the user the conversation does not contain
something it does contain. The system prompt actively pushes toward the second —
it says an empty-looking result means the words genuinely are not there.

It only bites messages longer than `SEARCH_HISTORY_TEXT_CHARACTERS` (600), which
in a chat means pasted documents rather than typed turns. That is a narrow case
today and exactly the case the feature is for: nobody asks "what did I say" about
a message they can reread in one glance.

## Why the test suite did not catch it

`"shows the part of a long message that matched, not its opening"` in
`src/lib/search/chat-history.test.ts` asserts precisely this property, and it
passes. Its fixture puts both query terms adjacent at the *end* of the paste, so
the earliest match and the informative match are the same position. The
assertion is right; the fixture cannot distinguish the two rules.

Whatever fix lands should add a fixture where a query term appears early and the
answer appears late — the shape above.

## Options

The second was taken.

**Anchor on the rarest matched term.** `BM25Index` already carries `df`, and
`searchChatHistory` holds the index when it builds the hit, so the lowest-`df`
term is available at no extra cost. Cheap, and it is the same signal BM25 already
uses to decide the message matched at all. It still cuts around a single point,
so a query whose terms are genuinely spread through a long message keeps only
one of them.

**Anchor on the densest cluster of matched terms.** Slide a window and pick the
one containing the most matched terms, weighted by `idf`. Strictly better output,
and it degrades to the rarest-term answer when the terms are far apart. Costs a
pass over the match positions and more code in a function that is currently ten
readable lines.

The first was the cheaper guess and it is not sufficient: in the reproduction
above both `completion` and `date` occur in one message and nowhere else, so
their `df` is equal, the tie falls back to the earliest position, and the bug
survives its own repro. A chat is a corpus of a few hundred short documents —
ties at `df` 1 are the normal case, not the edge. So the density rule landed
instead, with `idf` as the weight so it degrades to the rarest-term answer when
no window can hold two terms.

The implementation is in `snippet` in `src/lib/search/chat-history.ts`: each
occurrence of each matched term proposes a window starting a lead-in before it,
each window scores the `idf` of the distinct matched terms inside it, highest
score wins and ties go to the earliest. `searchChatHistory` passes the `idf` in
from the same `BM25Index` that decided the message matched, so there is no
second notion of what a rare word is.

Both shapes are now fixtures in `chat-history.test.ts` — a query term early with
the answer late, and two terms too far apart to share a window — and both fail
against the previous anchor.

## Not the same bug

Truncation at the *end* of a snippet is correct and deliberate: a snippet ending
in `…` tells the model there is more of the message, and the budget exists to
stop one paste dominating the payload. The defect is only in where the window
starts.

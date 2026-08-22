# Plan: Window and Backlog

> Source PRD: the design conversation of 2026-08-21/22, recorded in
> `docs/adr/0002-the-backlog-is-dropped-not-summarised.md`,
> `docs/adr/0003-the-backlog-is-searched-lexically-outside-the-document-layer.md`,
> and the `Window` / `Backlog` / `Corpus` entries in `CONTEXT.md`.

A long chat cannot all be sent on every turn. The assistant is shown a **Window**
of recent messages; everything older is the **Backlog**, which it can search but
is not shown. The user's view of the chat never changes.

## Architectural decisions

Durable across all phases:

- **Window**: the most recent 20 messages. Counted in messages, not tokens —
  text messages are small and uniform, so the count is honest, deterministic and
  debuggable. `20` is the one number here with no argument behind it; it is a
  constant to tune, not a decision to defend.
- **Where the Window is applied**: in the chat route, after
  `safeValidateUIMessages` and before `convertToModelMessages`. Validation still
  sees the whole message list, so persisted tool parts are still validated
  against their schemas.
- **Persistence is untouched.** The full chat is written to and read from
  `data/db.local.json` exactly as now. The Window is a view for one model call,
  not a retention policy. The user always sees the whole chat.
- **Tool output is not prose.** Tool output survives only on the most recent
  assistant message; older calls are stubbed down to what was called. It is
  roughly all of the bytes and almost none of the meaning, and during a turn the
  model's tool results arrive from the live loop rather than from history.
- **Backlog corpus**: BM25F only, over `text` parts only, both roles, one
  document per message. Built directly on `bm25.ts` and `tokenize.ts`. It is
  **not** a `DocumentSource` and never touches `documents.ts` — see ADR 0003.
- **Backlog index lifetime**: in-memory, keyed by chat id, built from the
  in-memory message array rather than re-read from disk, invalidated on message
  count. It dies with the chat and with the process. Nothing about a deleted
  chat outlives it.
- **Tool**: `searchHistory`, the seventh tool given to the chat loop. Fires on
  the user's signal, not on the model's suspicion — there is no manifest and no
  summary of the Backlog (ADR 0002).
- **Message part**: `tool-searchHistory`, rendered as a collapsible block like
  the other tool parts.

---

## Phase 1: The Window drops old messages

**User stories**: a chat that has run for fifty turns still answers, without
sending fifty turns to the model.

### What to build

The Window, and nothing else. The chat route trims the validated message list to
the most recent 20 messages before converting it for the model. Tool outputs are
left exactly as they are for now. Everything downstream — the system prompt, the
memories block, the tools, persistence, the UI — is unchanged.

This phase deliberately ships a regression: between here and Phase 3 the
assistant can lose something with no way to recover it. That is accepted.

### Acceptance criteria

- [x] A chat with more than 20 messages sends only the most recent 20 to the model
- [x] A chat with 20 or fewer messages is sent unchanged
- [x] The last message sent is still the user's, and the route's existing 400s on
      an empty or non-user last message are unaffected
- [x] The full chat is still persisted and still rendered in the UI
- [x] The Window size is a single named constant with a comment explaining that it
      is a starting value

---

## Phase 2: The Window stubs old tool outputs

**User stories**: a turn that ran six searches does not cost 39 KB on every
subsequent turn.

### What to build

Within the Window, tool output is kept only on the most recent assistant
message. Older tool parts are replaced with a stub naming what was called and
what it returned in outline — enough for the model to repeat the call, not
enough to answer from.

This is the riskiest slice, which is why it is early: a stubbed tool part still
has to convert into a valid assistant/tool message pair. That needs a test, not
a hope. Every tool here reads from a corpus still on disk, so a stubbed call is
recoverable by calling the tool again.

### Acceptance criteria

- [ ] The most recent assistant message keeps its tool output in full
- [ ] Every older tool part in the Window is stubbed
- [ ] A message list containing stubbed tool parts converts to model messages
      with correctly paired tool calls and results — covered by a test, for every
      tool in the set
- [ ] A turn's own tool results are unaffected during that turn
- [ ] Measured: a chat whose history contains a large multi-search turn sends
      materially fewer tokens than before

---

## Phase 3: `searchHistory`, end to end

**User stories**: "we talked about this before — what did I say about the school
stuff?" is answered from the conversation rather than by asking the user to
repeat themselves.

### What to build

A thin complete path: build a BM25F index over the chat's `text` parts, expose it
as `searchHistory`, wire it into the chat loop, and render its results in the
transcript. Hits are bare matched messages at this stage.

The prompt work is part of this slice, not a follow-up. Seven tools mean the
failure to design against is the wrong reach, and `searchHistory` sits close to
`searchEmails` in both name and shape — the tool-choice rules must name that
wrong reach explicitly, the way they already do for `contains`-as-search. The
tool description is also the only thing telling the model this corpus exists at
all.

### Acceptance criteria

- [ ] An index is built over the chat's `text` parts only; tool output is never
      indexed
- [ ] The index is built from the in-memory message list, cached per chat, and
      rebuilt when the message count changes
- [ ] `documents.ts` and the source registry are untouched
- [ ] The tool returns matched messages for a query naming words the user
      actually used earlier in the chat
- [ ] The system prompt distinguishes `searchHistory` from `searchEmails`, and
      names the wrong reach
- [ ] `tool-searchHistory` renders as a collapsible block consistent with the
      other tool parts
- [ ] End-to-end: a fact stated before the Window and asked about after it is
      answered correctly when the user signals that it was discussed

---

## Phase 4: Hit shape and the restatement rule

**User stories**: what comes back from the Backlog is intelligible on its own,
and does not have to be found twice.

### What to build

Each hit carries its ±1 neighbouring messages and its position in the chat
(`turn 3 of 47`) — a hit on "yes, do that" is worthless alone, and "you said this
near the start" changes how the model weighs it. Hits already inside the Window
are marked or dropped rather than returned as though they were news.

Plus one prompt rule: when the model recovers something from the Backlog, it
restates it in its own prose reply. A tool result is not indexed and is stubbed
on the next turn, so a recovered fact otherwise flickers in and out of existence.
Prose is indexed, stays in the Window, and survives.

### Acceptance criteria

- [ ] Each hit includes its immediate neighbours and its turn position
- [ ] A hit that falls inside the current Window is marked or omitted
- [ ] Neighbour expansion is bounded at the start and end of a chat
- [ ] The system prompt instructs the model to restate what it recovers
- [ ] Observed: after recovering a fact, the reply contains it in prose, and a
      follow-up question in the next turn is answered without searching again

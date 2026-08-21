# Memories in chat

Status: **implemented.** Written from the design conversation that started as
"a memory search tool" and ended somewhere else, then updated as it was built.

## Problem statement

`DB.Memory` has existed since the persistence layer was written. Memories are
created in a modal, listed in the sidebar, deleted from it — and **read by
nothing**. `loadMemories` has exactly one caller, the sidebar. The chat loop has
never seen a memory.

So the assistant restarts from zero every conversation. It cannot know that the
user writes British English, that "my accountant" means Sarah at Meridian, or
that the flat purchase completed in March — facts that change how well every
email answer lands, and that the user has to retype into every chat.

## What this is not

The feature was asked for as *memory search*: a tool the model calls to retrieve
relevant memories. It is not that, and the reasoning matters because the repo is
full of retrieval machinery that makes search look like the obvious answer.

Retrieval solves a problem this corpus does not have. The email corpus is ~900
chunks and static. Memories are expected to number in the tens, are written by
the user in their own words, and are a few sentences each — thirty of them is
under 1500 tokens, a fraction of what `SYSTEM_PROMPT` already costs.

More decisively: **a retrieved memory only arrives when the model thinks to look
for it**, and the memories that matter most are the ones the model does not know
it is missing. "Reply in British English" has to apply on the turn where nothing
about the question suggests searching for a writing preference. A tool cannot
deliver that. The prompt can.

See [ADR 0001](./adr/0001-memories-are-injected-not-retrieved.md).

An earlier draft of this design split memories into *directives* (always in the
prompt) and *notes* (retrieved on demand). Injecting everything collapses the
two: if every memory is in every prompt, there is no second concept. One term,
**Memory**, defined in [CONTEXT.md](../CONTEXT.md).

## Design

Three changes, in dependency order.

### 1. Memories reach the model

`SYSTEM_PROMPT` becomes a function of the loaded memories. `route.ts` already
calls into the persistence layer; it gains a `loadMemories()` alongside its
`getChat`.

Each memory renders with its id, because the update tool below needs the model to
be able to name one:

```
<memories>
Things you know about the user, from earlier conversations and from what they
have told you directly. They apply to every reply. If one contradicts what the
user says now, believe the user and call updateMemory.

- [<id>] <title>: <content>
</memories>
```

The block is omitted entirely when there are no memories, rather than rendered
empty — an empty section invites the model to remark on having no memories.

**Ordering** is whatever `loadMemories` returns, which is `updatedAt`
descending. Newest first is the safe default while contradictions are possible,
since the model reads the current version before the stale one. It is a guess,
not a finding — see open questions.

### 2. `saveMemory` and `updateMemory`, given to the chat loop

Two new entries in `chatTools`. Adding tools is safe for persisted history;
renaming or removing them is not (`tools.test.ts`).

These are the first **mutating** tools in this app. Every existing tool reads a
static committed corpus; these write to `data/db.local.json`, and what they write
enters every future prompt. That difference drives most of what follows.

**`saveMemory({ title, content })`** — records a new fact about the user.

The model **may volunteer**. It does not wait to be asked: a user who mentions
they are moving to Berlin in March should not have to add "and remember that".
This is the useful behaviour and it is also the risky one, so it is bounded in
the tool description rather than by a switch:

- Save facts about the user's world, standing preferences, and how they want to
  be addressed or answered. Not facts about an email — those are in the corpus
  and searchable.
- Not things that will be false next week.
- One self-contained fact per call, written so it is legible with no
  conversation around it. The content is stored verbatim; there is **no
  summarisation call on this path** — a model asked for a one-sentence fact has
  already done the summarising, and a second model call to compress it is a
  round-trip for nothing.
- Check the `<memories>` block first. If this revises something already there,
  call `updateMemory` instead.

**`updateMemory({ id, title, content })`** — revises one, by the id from the
prompt block. `updateMemory` already exists in `persistence-layer.ts`, unused
and unexposed; this is its first caller.

It exists because `createMemory` appends and nothing dedupes. Without it, "I
prefer British English" said in two chats is two identical memories in every
future prompt, and a later "actually, American" is two contradictory
instructions the model resolves by list order. Update is the mechanism that
keeps the block coherent as it grows.

An id that matches nothing returns `{ updated: false }` rather than throwing,
and the description tells the model what that means: it invented the id, and
should call `saveMemory` instead of guessing another.

**No delete tool.** Update covers revision, which is the case that comes up.
Deletion is the one memory operation with no recovery — there is no undo in a
JSON file — and it is one click away in the sidebar, which is where a decision
to forget something belongs. The asymmetry is deliberate: the model may add and
correct what the assistant knows; only the user may erase it.

### 3. The user can see it happen

A memory written silently is the failure mode of a volunteering model: the
corpus grows behind the user's back, each entry steering every future reply,
with the sidebar as its only window.

Two things make it visible, both reusing machinery that exists:

- **The sidebar updates live.** Both tools write the transient
  `data-frontend-action: "refresh-sidebar"` part, exactly as new-chat creation
  and title generation already do. The client's `onData` handler calls
  `router.refresh()` and the memory appears without a reload.
- **The call is rendered in the transcript.** `chat.tsx` renders tool parts
  through `TOOL_TITLES` and a shared collapsible block; `tool-saveMemory` and
  `tool-updateMemory` join it — "Saved something to memory" / "Updated what it
  remembers". Same shape as the four email tools, no new component.

### 4. Titles on the modal path

The modal makes the user type a title before it will accept a memory, which is
friction on the one path where the content arrives raw. That is where the
OpenAI call belongs — not on the tool path, where the model has already written
one.

`createMemoryAction` generates a title when none is given, one-shot with
`gpt-5.4-nano`, the same shape as `generate-title.ts`. The title field in the
modal becomes optional rather than disappearing: a user who wants to name it
should not be overruled.

A failed generation falls back to a truncation of the content. A memory the user
typed is not lost because a provider was down.

## Failure modes

| What fails | What happens |
|---|---|
| `loadMemories` throws | It already cannot — it catches and returns `[]`. The block is omitted and chat works as it does today. |
| Title generation fails | Fall back to truncated content. The memory is still saved. |
| `saveMemory` writes a duplicate | Both appear in the prompt. Update is the fix, and the model is told to check the block first. Not prevented. |
| Model invents an id for `updateMemory` | `{ updated: false }`, and the description tells it to save instead. |
| Memory count grows unbounded | Nothing, until it silently costs money and the model starts ignoring the middle of the list. See below. |

## The number that breaks this

Injecting everything is right at twenty and wrong at five hundred — and it goes
wrong quietly, as cost and as a model that stops reading the middle of a long
list. Until now growth was gated by a human typing into a modal; a volunteering
write tool removes that gate.

No cap is built. `loadMemories` gains a `console.warn` above a threshold
(**100**, a round number chosen to be well past normal use and well short of a
real problem), so the ceiling is something we discover rather than hit. Passing
it is the signal to revisit retrieval — and if that day comes, the memory corpus
will finally be big enough for the search stack that already exists to be worth
pointing at it.

## Open questions

- **Prompt ordering.** Newest-first is inherited from `loadMemories`, not
  measured. Recency bias favours the end of a prompt, which argues for
  oldest-first. Worth one eval once there are enough memories to tell.
- **Volunteering rate.** Whether the model saves too eagerly is not knowable
  from the tool description alone. Watch the first fifty real conversations
  before tightening or loosening it.
- **Scope.** Memories are global across chats. Nothing here contemplates a
  memory that belongs to one conversation, and nothing needs it yet.

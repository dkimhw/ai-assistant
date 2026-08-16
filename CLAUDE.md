# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- **Package manager**: Use `pnpm` for all package operations
- **Start dev server**: `pnpm run dev` (uses Turbopack, runs on http://localhost:3000)
- **Build**: `pnpm run build` (uses Turbopack)
- **Start production**: `pnpm start`
- **Test**: `pnpm run test` (vitest, single run) / `pnpm run test:watch`
- **Typecheck**: `pnpm run typecheck` (`tsc --noEmit`)
- **Build email vectors**: `pnpm run build:vectors` (tsx script, reads `.env` if present)

There is no lint script.

## Coding standards

House style lives in the `coding-standards` skill
(`.claude/skills/coding-standards/`), split by area — TypeScript, routes, lib
modules, data, testing, UI. Read the relevant `references/*.md` before writing
code. The testing suite is described in full in `docs/testing.md`.

## Architecture

A Next.js 15 personal-assistant app: a streaming chat UI, a persisted chat and
memory store, and a BM25F lexical search over an email corpus.

### Key Technologies

- **Framework**: Next.js 15 (App Router), React 19
- **AI SDK**: Vercel AI SDK (`ai`) with `@ai-sdk/react` on the client
- **Model**: `gpt-5.4-mini` for chat, `gpt-5.4-nano` for titles and for reranking
  search results, all via `@ai-sdk/openai` and all named in
  `src/app/api/chat/model.ts`.
  `@ai-sdk/google` and `@ai-sdk/anthropic` are installed but not wired up.
- **Streaming**: `streamText` composed into a custom `createUIMessageStream`
- **Tools**: four over the email corpus — relevance search, exact-criteria
  filter, thread-state triage, and full-text fetch — given to the chat loop with
  a step limit
- **Persistence**: a single JSON file, `data/db.local.json` (no database)
- **Search**: hand-rolled BM25F over `data/emails.json`, fused with a semantic
  ranking by RRF, then reranked by an LLM for the chat tool only; no search
  dependency
- **Testing**: vitest; `evalite` is installed and configured for relevance evals
  but has no suites yet
- **Markdown**: `streamdown` for rendering
- **UI**: shadcn/Radix components + Tailwind CSS 4, dark mode via `next-themes`

### Directory Structure

- `src/app/page.tsx` — chat screen (server component); reads `?chatId`
- `src/app/chat.tsx` — the client chat component, `useChat`
- `src/app/api/chat/route.ts` — streaming chat endpoint; also exports `MyMessage`
- `src/app/api/chat/generate-title.ts` — one-shot `generateText` title generation
- `src/app/api/chat/model.ts` — the model ids and the OpenAI key convention
- `src/app/api/chat/tools.ts` — the tool set the chat loop is given
- `src/app/actions/memories.ts` — server actions for memory CRUD
- `src/app/search/` — email search page plus its route-local components
- `src/lib/search/` — `bm25.ts`, `tokenize.ts`, `rrf.ts`, `semantic.ts`,
  `reranker.ts` (all corpus-agnostic), `documents.ts` (the source registry and
  `searchDocuments`), `document-id.ts` (the id scheme), `date-boundary.ts` (the
  `after`/`before` schema fragment and its parsing, shared by the filter and
  triage tools), `emails.ts` (the email source adapter, which also owns
  `INBOX_OWNER`, `isAutomatedSender` and `getThreadStates`), and
  `email-search-tool.ts`, `email-filter-tool.ts`, `email-triage-tool.ts` and
  `email-get-tool.ts` (the adapter shaped as four AI SDK tools), with tests
- `src/lib/persistence-layer.ts` — JSON-file store for chats and memories
- `src/components/ai-elements/` — AI chat UI primitives
- `src/components/ui/` — shadcn/Radix primitives
- `docs/` — `bm25-search.md` and `hybrid-search.md` (design), `chunking.md`
  (chunking strategies and the one we chose), `testing.md` (test suite),
  `bm25-explained.html`, `hybrid-search-explained.html`

Components used by exactly one route live in that route's folder; only shared
ones live in `src/components/`.

### Chat Route Pattern

`/api/chat` validates the incoming messages with `safeValidateUIMessages<MyMessage>`
and returns `400` on failure or if the last message isn't from the user. It then
builds a `createUIMessageStream` and merges the model stream into it:

```typescript
const stream = createUIMessageStream<MyMessage>({
  execute: async ({ writer }) => {
    const result = streamText({
      model: getChatModel(),
      system: SYSTEM_PROMPT,
      messages,
      tools: chatTools,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: req.signal,
      prepareStep: ({ stepNumber }) =>
        stepNumber === MAX_STEPS - 1 ? { toolChoice: "none" } : undefined,
    });
    writer.merge(result.toUIMessageStream({ sendSources: true, sendReasoning: true }));
  },
  onError: (error) => { /* log; return a coarse string */ },
  onFinish: async ({ responseMessage, isAborted }) => { /* persist if non-empty */ },
});
return createUIMessageStreamResponse({ stream });
```

`safeValidateUIMessages` must be passed `chatTools` too. Persisted tool parts are
replayed on the *next* request, and the argument is what gets them validated
against the tool's schema rather than waved through — see
`src/app/api/chat/tools.test.ts`.

The writer form (rather than `result.toUIMessageStreamResponse()`) is what allows
persistence and custom data parts to interleave with the model output.

Persistence happens *inside* the stream: a new chat is created in `execute`, and
the assistant reply is appended in `onFinish`, so a disconnect still records the
exchange. A message with no content is the one thing not persisted — an abort
before the first token would otherwise write an empty assistant turn that is
replayed forever. Title generation for a new chat is kicked off early, kept as a
promise, and awaited at the end of `execute` so it never blocks the first token.

Four things bound one turn, and they are separate concerns: `stopWhen` caps the
step count, `abortSignal` ends a turn the client walked away from, `prepareStep`
withdraws the tools for the final step so the turn lands on prose instead of
stopping after a tool call, and the search budget in the system prompt stops a
question with no retrieval target from spending the ceiling in the first place.
`onError` logs the real error and returns a coarse string — a provider error can
carry key fragments, and that string is rendered in the transcript.

### Message Parts System

Messages have a `parts` array that can contain multiple types:

- `text` — regular text content
- `reasoning` — extended thinking content
- `source-url` — URLs referenced in responses
- `tool-searchEmails` — an email search call, rendered as a collapsible block
- `tool-filterEmails` — an exact-criteria filter call, rendered the same way.
  Its output is `{ totalMatches, emails }`, not a bare array: the count is the
  point, and it is the pre-cap total
- `tool-triageEmails` — a thread-state review, rendered the same way. Its output
  is `{ totalMatches, threads }`, and the rows are **threads**, not emails — the
  only tool whose unit is a conversation
- `tool-getEmails` — a full-text fetch by id, rendered the same way. Output is
  `{ emails, missingIds }`; bodies here are **not** truncated

`MyMessage` is the project's `UIMessage` specialisation. It adds a custom
`data-frontend-action` part carrying `"refresh-sidebar"`, written with
`transient: true` so it is never persisted into history. The client handles it in
`useChat`'s `onData` by calling `router.refresh()` — this is how the sidebar
picks up a newly created chat and its generated title.

### Search Architecture

Three layers, deliberately: corpus-agnostic rankers, a document layer, and source
adapters.

- `bm25.ts`, `semantic.ts`, `rrf.ts` and `tokenize.ts` know nothing about emails
  — documents are `{ id, fields }` or `{ id, vector }`, and ids are opaque.
- `documents.ts` owns the source registry and the single public entry point,
  `searchDocuments`. It mints ids, unions every source into one index of each
  kind, fuses the two rankings, and collapses chunk hits back to documents. It
  never inspects a document's content. `sources`, `embedder` and `reranker` are
  all injectable, so tests use fakes rather than mocks.
- `emails.ts` is the first source adapter: it reads the corpus, maps `Email` onto
  subject/body/from/to, owns the field weights (`{ subject: 3, body: 1, from: 2,
  to: 1 }`, a starting guess to be tuned against evals), delegates chunking to
  `email-chunks.ts`, and supplies the committed vectors. `searchEmails` is a thin
  wrapper over `searchDocuments` so the search page still receives `Email`s.

Passing a `reranker` to `searchDocuments` adds a stage after fusion: a pool of
`RERANK_CANDIDATE_POOL` fused documents has its *chunks* read and reordered by an
LLM, then collapses one-per-document again, and each result gains the chunk it
won on. It is off unless asked for — the search page does not pass one and is
unchanged; `searchEmails` from the chat tool does. `reranker.ts` mirrors
`embedder.ts`: a provider-agnostic `Reranker` (opaque ids, text, an order out —
no scores) plus one OpenAI implementation, so a cross-encoder later is a new
implementation and no pipeline change. A failing reranker degrades to the fused
ordering, exactly as a failing embedder degrades to lexical-only.

The chat tool passes the last `EMAIL_SEARCH_HISTORY_MESSAGES` user and assistant
messages as rerank context, so "what was the deadline on that?" is ranked against
what was being discussed. Tool calls and tool results are filtered out in
`email-search-tool.ts` — feeding a retrieval system its own previous retrievals
sticks a conversation in one neighbourhood of the corpus. History reaches the
reranker and nothing else; the BM25F and semantic legs still see only the query.

Document ids are `${sourceType}:${nativeId}` (`email:email_1759…`) and chunk ids
are `${documentId}#${n}`. `:` and `#` are reserved and rejected at index time;
formatting and parsing live only in `document-id.ts`. A source with no natural id
declares `hasNativeIds: false` and gets a content hash instead.

The corpus and the built indexes are memoised for the process lifetime. `emails.ts`
and `documents.ts` are **server-only** — they read from disk with `node:fs`.
Design rationale is in `docs/bm25-search.md` and `docs/hybrid-search.md`.

Adding a kind of document: write a `DocumentSource`, register it in
`documents.ts`, run `pnpm run build:vectors`.

#### Thread state, which is not search at all

`triageEmails` runs beside that pipeline rather than through it: no query, no
ranking, no embeddings. `emails.ts` derives one `ThreadState` per thread —
message count, last message, and `awaiting: "you" | "them"` from who sent it —
memoised like the corpus itself, and `email-triage-tool.ts` filters and shapes
those rows.

Two pieces of corpus knowledge it needs live in `emails.ts` beside the adapter:

- `INBOX_OWNER` — inbound and outbound have no meaning without it, and the corpus
  never states it. A constant rather than an inference, so a quiet owner cannot
  silently become someone else.
- `isAutomatedSender` — a local-part prefix test, and the load-bearing heuristic:
  it decides 158 of the 258 threads that would otherwise read as "waiting". It
  was validated by hand against all 56 distinct senders and deliberately does
  **not** generalise to role addresses (`bookings@`, `info@`, `admin@`,
  `support@` are all staffed by people here, several asking direct questions).

The tool returns facts and refuses to rank: `waitingDays`,
`lastMessageAsksQuestion`, `lastSenderIsAutomated`, and no `urgent` field
anywhere. Deciding what matters is the model's job, and the system prompt says
so.

Two ordering decisions are load-bearing, because a cap of 15 over ~92 candidates
means the sort decides what the model can see at all:

- **Newest-first, not longest-waiting-first.** The corpus spans two and a half
  years, so longest-waiting fills every slot with abandoned 2024 threads.
  Staleness is still on each row as `waitingDays`.
- **Threads whose last message is in the future are excluded.** 36 emails are
  dated after today; 8 are the last message of a waiting thread, and
  newest-first put all 8 at the top reporting 0 days waited. A message that has
  not arrived is not waiting on a reply — the other three tools still see it.

Rationale is in `src/lib/search/email-triage-tool.ts` and issue #15.

### Component Architecture

AI elements are composable primitives:

- **Conversation**: container with scroll management
- **Message/MessageContent**: individual message bubbles
- **PromptInput**: input with attachments, model selection, and submit controls
- **Response**: wrapper around `Streamdown` for markdown with syntax highlighting
- **Reasoning**: collapsible extended thinking blocks
- **Sources**: collapsible source citations

`src/components/ui/` and `src/components/ai-elements/` are generated by the
shadcn CLI (`components.json`) — wrap them rather than editing them in place.

### Conventions

- Use the `@/*` alias for anything under `src/`; `./` only for siblings in a
  route folder.
- Functions taking more than one argument of the same type take a single object
  parameter instead.
- Use `cn()` from `@/lib/utils` for conditional classnames (clsx +
  tailwind-merge). Style with semantic theme tokens (`bg-background`,
  `text-muted-foreground`), never raw palette colours — they break dark mode.
- Search, pagination, and filter state live in the URL, not React state.

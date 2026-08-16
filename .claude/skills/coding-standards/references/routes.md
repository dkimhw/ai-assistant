# Route standards

Next.js 15 App Router. Everything lives under `src/app/`. There are three ways
into server code, and they are not interchangeable.

| Kind               | Where                      | Use for                                    |
| ------------------ | -------------------------- | ------------------------------------------ |
| Page               | `src/app/**/page.tsx`      | Rendering a screen; reads data directly    |
| Route handler      | `src/app/api/**/route.ts`  | Streaming and anything the AI SDK calls    |
| Server action      | `src/app/actions/*.ts`     | Mutations invoked from client components   |

**Don't put business logic in any of them.** Call into `src/lib/*` — see
[lib.md](lib.md). Routes parse input, call a module, and shape the response.

## Pages

Pages are async server components. `searchParams` is a **Promise** in Next 15 —
await it, and coerce defensively, since every value is user-controlled:

```tsx
export default async function SearchPage(props: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const searchParams = await props.searchParams;
  const query = searchParams.q || "";
  const page = Math.max(1, Math.floor(Number(searchParams.page)) || 1);
```

`Number(undefined)` is `NaN` and `NaN || 1` is `1`, so that idiom handles
missing, non-numeric, negative, and fractional input in one line. Reuse it.

Route-local components live in the route folder next to the page
(`src/app/search/search-input.tsx`), not in `src/components/`. Only genuinely
shared components graduate — see [ui.md](ui.md).

## Server actions

`"use server"` at the top of the file, one file per domain in
`src/app/actions/`. Every action takes an **object parameter** and is named with
an `Action` suffix:

```ts
export async function createMemoryAction(opts: {
  title: string;
  content: string;
}): Promise<DB.Memory> {
  return await createMemory({ id: crypto.randomUUID(), ...opts });
}
```

Actions are a thin wrapper over the persistence layer. Ids are minted here with
`crypto.randomUUID()`, not in the persistence layer, so the caller controls
identity.

## Route handlers and streaming

`src/app/api/chat/route.ts` is the reference. The rules that matter:

- **Validate before use.** Run `safeValidateUIMessages` on the request body and
  return `400` with the error message on failure. Never pass an unvalidated body
  to `convertToModelMessages`.
- **Guard the message invariant explicitly** — non-empty, last message is from
  the user — each with its own `400`. These are cheap and catch client bugs at
  the boundary.
- **Type the stream.** `MyMessage` is the project's `UIMessage` specialisation
  and carries the custom `data-frontend-action` part. Pass it as the generic to
  `safeValidateUIMessages<MyMessage>` and `createUIMessageStream<MyMessage>`.
- **Persist inside the stream, not around it.** Writes happen in `execute` and
  `onFinish` so a client disconnect still records the exchange. Persist nothing
  *empty*, though — an abort before the first token would otherwise write a
  blank assistant message that replays forever as a gap in the conversation.
- **Fire-and-await background work.** Title generation starts early, is kept as a
  promise, and is awaited at the end of `execute` — don't block the first token
  on it.
- **Handle errors explicitly.** `createUIMessageStream`'s default `onError`
  returns "An error occurred." and drops the error entirely, so nothing reaches
  the log. Log the real one; return something coarse. Provider errors can carry
  key fragments and internal URLs, and the returned string is rendered in the
  user's transcript.

Custom UI signals go over `writer.write({ type: "data-...", transient: true })`.
`transient` means it isn't persisted into message history; use it for anything
that's an instruction to the UI rather than conversation content.

### Bounding a streaming turn

**Don't reach for `maxDuration`.** It was removed from the chat route in
`2b77713` after being confirmed inert: this app runs as a long-lived Node
process, so nothing enforces a per-request function timeout, and the build's
`functions-config-manifest.json` came out empty. Adding it back is cargo cult
until the app moves onto a platform that deploys routes as functions — at which
point it returns, sized for a whole tool loop rather than one model call.

What that leaves is four separate bounds, none of which substitutes for another.
A tool-calling loop needs all of them:

| Bound | Mechanism | Stops |
| ----- | --------- | ------ |
| Step count | `stopWhen: stepCountIs(n)` | An endless tool loop |
| Landing | `prepareStep` → `toolChoice: "none"` on the last step | A turn ending on a tool call with no reply |
| Client gone | `abortSignal: req.signal` | Work nobody is waiting for |
| Provider hang | `AbortSignal.timeout()` on each provider call | One dead connection hanging the request |

The last one is the easiest to forget and the worst to omit, because there is no
platform timeout underneath to catch it — see `reranker.ts` and `embedder.ts`.
Prefer a call that degrades on timeout (fall back to a worse ranking) over one
that throws, wherever the stage is optional.

`stopWhen` on its own is a guillotine: it ends the turn after the Nth step
whatever that step was. Pair it with `prepareStep` so the turn lands on prose.

## Validation

Zod is available for request-body and form validation. Validate at the boundary
— the route handler or the action — and hand `src/lib/*` already-typed values.

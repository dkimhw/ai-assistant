# TypeScript conventions

## Object parameters over positional ones

When a function has more than one parameter of the same type (e.g. two `string`s),
take a single object parameter. Positional same-typed params are trivially swapped
at the call site and the compiler won't catch it.

```ts
// BAD
const addUserToPost = (userId: string, postId: string) => {};

// GOOD
const addUserToPost = (opts: { userId: string; postId: string }) => {};
```

This holds for optional config too — `searchBM25({ index, query, limit, minScore })`
rather than four positional arguments.

Note that some older functions in `persistence-layer.ts` still take a leading
positional id (`updateMemory(memoryId, { title, content })`). Follow the object
form in new code; don't churn the existing signatures without a reason.

## Import alias

Use the `@/*` alias for anything under `src/`. Don't use deep relative imports.

```ts
// BAD
import { cn } from "../../lib/utils";

// GOOD
import { cn } from "@/lib/utils";
```

Sibling files inside a single route folder are the exception — `src/app/search/page.tsx`
importing `./search-input` is fine and keeps the folder self-contained.

## Arrow consts for new modules

New modules use exported arrow consts (`export const tokenize = (text: string) => {}`).
`persistence-layer.ts` predates this and uses `export async function`; leave it be.

## No `any`

Don't use `any`. Derive the type from whatever owns it:

- AI SDK message shapes → the `MyMessage` generic exported from
  `@/app/api/chat/route`, not a hand-written interface.
- Persistence shapes → the `DB` namespace in `@/lib/persistence-layer`
  (`DB.Chat`, `DB.Memory`).
- Anything else → `typeof` inference off the value that already exists.

Prefer `type` aliases over `interface` in new code, matching `src/lib/search/*`.

## Exported types travel with their module

Types belong next to the function that returns them, exported from the same file
(`BM25Document`, `BM25Index`, `BM25Result`, `Email`). Don't create a central
`types.ts`.

---
name: coding-standards
description: Project coding standards. Use when writing or reviewing any code in this repo — before adding a route, server action, lib module, test, or component, and when checking whether existing code follows the house style.
user-invocable: false
---

# Coding standards

Standards live in `references/`, split by area. Read the file for the area you're
touching before writing code — don't read all of them.

| Touching...                                              | Read                                      |
| -------------------------------------------------------- | ----------------------------------------- |
| Any TypeScript at all                                    | [typescript.md](references/typescript.md) |
| `src/app/**/page.tsx`, `route.ts`, `actions/*`           | [routes.md](references/routes.md)         |
| `src/lib/*` — search, shared logic, module boundaries    | [lib.md](references/lib.md)               |
| `src/lib/persistence-layer.ts`, `data/*`                 | [data.md](references/data.md)             |
| `*.test.ts` — any test file                              | [testing.md](references/testing.md)       |
| `src/components/*`, `src/app/*.tsx` — components, styling | [ui.md](references/ui.md)                 |

## Always apply

These three are short enough to carry everywhere; the rest is in the files above.

- Use the `@/*` import alias for anything under `src/`. Never `../../lib/utils` —
  write `@/lib/utils`. Sibling files within one route folder may use `./`.
- Don't use `any`. Derive types from the source of truth with `typeof` or the
  library's own generics instead.
- More than one parameter of the same type → take a single object parameter.

  ```ts
  // BAD
  const addUserToPost = (userId: string, postId: string) => {};
  // GOOD
  const addUserToPost = (opts: { userId: string; postId: string }) => {};
  ```

## Stack

Next.js 15 App Router (Turbopack) · React 19 · Vercel AI SDK (`ai`,
`@ai-sdk/react`, `@ai-sdk/google`, `@ai-sdk/anthropic`) · JSON-file persistence,
no database · Zod validation · vitest · evalite for relevance evals · Tailwind 4
+ shadcn/Radix.

Package manager is `pnpm`. Dev server `pnpm run dev`, tests `pnpm run test`.

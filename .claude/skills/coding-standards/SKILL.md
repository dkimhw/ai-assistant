---
name: coding-standards
description: Project coding standards. Use when writing or reviewing any code in this repo — before adding a route, service, schema column, test, or component, and when checking whether existing code follows the house style.
user-invocable: false
---

# Coding standards

Standards live in `references/`, split by area. Read the file for the area you're
touching before writing code — don't read all of them.

| Touching...                                          | Read                                      |
| ---------------------------------------------------- | ----------------------------------------- |
| Any TypeScript at all                                | [typescript.md](references/typescript.md) |
| `app/db/schema.ts`, columns, migrations, queries     | [database.md](references/database.md)     |
| `app/routes/*` — loaders, actions, forms, auth       | [routes.md](references/routes.md)         |
| `app/services/*` — business logic, return shapes     | [services.md](references/services.md)     |
| `*.test.ts` — any test file                          | [testing.md](references/testing.md)       |
| `app/components/*` — components, styling, formatting | [ui.md](references/ui.md)                 |

## Always apply

These three are short enough to carry everywhere; the rest is in the files above.

- Use `~/*` import aliases for anything in `/app`. Never `../../lib/utils` — write `~/lib/utils`.
- Don't use `any`. Infer from the Drizzle schema with `typeof` when unsure.
- More than one parameter of the same type → take a single object parameter instead.

  ```ts
  // BAD
  const addUserToPost = (userId: string, postId: string) => {};
  // GOOD
  const addUserToPost = (opts: { userId: string; postId: string }) => {};
  ```

## Stack

React Router v7 (file-based routing) · SQLite via better-sqlite3 + Drizzle · Zod
validation · vitest · Tailwind + shadcn.

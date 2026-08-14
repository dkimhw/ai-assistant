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

## Import alias

Use the `~/*` alias for anything inside `/app`. Don't use relative imports.

```ts
// BAD
import { cn } from "../../lib/utils";

// GOOD
import { cn } from "~/lib/utils";
```

## No `any`

Don't use `any`. If you're unsure of a type, check the Drizzle schema in
`app/db/schema.ts` or derive it with `typeof` inference:

```ts
import { lessonComments } from "~/db/schema";

type LessonComment = typeof lessonComments.$inferSelect;
type NewLessonComment = typeof lessonComments.$inferInsert;
```

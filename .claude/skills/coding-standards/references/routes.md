# Route standards

React Router v7 with file-based routing. Routes go in `app/routes/`. Each route
file can export `loader`, `action`, `default` (component), `meta`, and
`ErrorBoundary`.

**Don't put business logic directly in routes** — call into a service in
`app/services/` instead. Routes parse input, call a service, and shape the response.

## Validation

For form validation in route actions, use `parseFormData(formData, zodSchema)`
from `~/lib/validation`. It returns `{ success, data, errors }`.

- Route params → `parseParams`
- JSON request bodies → `parseJsonBody`

## Multiple submissions in one action

When a single route action handles several different form submissions (a page
with both a "mark complete" and a "delete comment" button), use a Zod
discriminated union on an `intent` field:

```ts
const schema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("mark-complete") }),
  z.object({
    intent: z.literal("delete-comment"),
    commentId: z.coerce.number(),
  }),
]);
```

## Auth

Cookie-based via `~/lib/session`. Use `getCurrentUserId(request)` in loaders and
actions; it returns `number | null`. Redirect to `/login` when it's `null`.

```ts
const userId = await getCurrentUserId(request);
if (!userId) throw redirect("/login");
```

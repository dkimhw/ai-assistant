# Service standards

Services live in `app/services/` and hold the business logic that routes call into.

## Tests are required

Anything named as a service (e.g. `authTokenService.ts`) must have tests in an
accompanying `.test.ts` file next to it. See [testing.md](testing.md) for the
required db-mock setup.

## Tagged results

When returning tagged/discriminated results from a service — as opposed to
validation, which uses `parseFormData` — use the `ok` pattern:

```ts
type Result = { ok: true; couponId: number } | { ok: false; error: string };
```

`couponService.ts` is the reference implementation.

## Multi-parameter signatures

Service functions almost always take an object parameter — see
[typescript.md](typescript.md).

# Testing standards

Tests use vitest with globals enabled (no importing `describe`/`it`/`expect`).

## Required db mock

Every test file must mock the db module exactly like this, and **the mock must
come before importing the service under test** — `vi.mock` is hoisted, so the
getter is what makes `testDb` resolve lazily per test.

```ts
let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));
```

## Setup

Use `createTestDb()` and `seedBaseData()` from `~/test/setup` in `beforeEach`.

```ts
import { createTestDb, seedBaseData } from "~/test/setup";
import { redeemCoupon } from "~/services/couponService";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

beforeEach(() => {
  testDb = createTestDb();
  seedBaseData(testDb);
});
```

## Coverage expectation

Every file named `*Service.ts` has a matching `*Service.test.ts`. Adding a
service means adding its test file.

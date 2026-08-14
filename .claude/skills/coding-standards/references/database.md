# Database standards

SQLite via better-sqlite3 + Drizzle. The db instance is initialized in
`app/db/index.ts` with WAL mode and foreign keys enabled. Don't create new
`Database` connections in service code unless you have a really good reason.

Schema lives in `app/db/schema.ts`.

## Primary keys

Always `integer().primaryKey({ autoIncrement: true })`. Don't use UUIDs.

```ts
id: integer().primaryKey({ autoIncrement: true }),
```

## Timestamps

Stored as ISO strings in `text` columns — not unix timestamps, not integers.

```ts
createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
```

## Booleans

Integers with Drizzle's `mode: "boolean"`.

```ts
pppEnabled: integer("ppp_enabled", { mode: "boolean" }),
```

## Money

Price values are stored in cents (integers). Display them with `formatPrice()`
from `~/lib/utils`, which also handles the "Free" case for `0`/`null`.

## Soft deletes

Use a nullable `text("deleted_at")` column. Don't actually delete rows, and
filter out soft-deleted rows in queries. See `lessonComments` in the schema for
a working example.

```ts
deletedAt: text("deleted_at"),
```

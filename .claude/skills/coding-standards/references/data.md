# Data standards

There is no database. Two JSON files under `data/`, with different rules.

| File                 | Contents                    | Written at runtime? | In git? |
| -------------------- | --------------------------- | ------------------- | ------- |
| `data/emails.json`   | The email corpus (500+)     | No — read-only      | Yes     |
| `data/db.local.json` | Chats and memories          | Yes                 | No      |

## The corpus — `data/emails.json`

Read once and cached for the process lifetime via `getAllEmails()` in
`@/lib/search/emails`. Read it through that function, never with your own
`readFileSync`, or you'll bypass the cache and the index built on top of it.

The `Email` type in that module is the schema. It is a fixture: stable, checked
in, and safe to assert against in tests — loosely (see [testing.md](testing.md)).

## Runtime state — `persistence-layer.ts`

A single JSON file holding `{ chats, memories }`, accessed only through
`@/lib/persistence-layer`. Conventions to keep:

- **Ids are strings**, minted by the caller with `crypto.randomUUID()`. Not
  auto-incrementing integers.
- **Timestamps are ISO strings** in `createdAt` / `updatedAt`. Set
  `updatedAt: new Date().toISOString()` on every mutation.
- **Lists come back newest-first**, sorted by `updatedAt` in the loader.
- **Missing means empty, not error.** `loadChats` / `loadMemories` catch a
  missing or malformed file and return `[]`. Callers never handle a read error.
- **Not-found is a null return, not a throw.** `getChat`, `updateChatTitle`, and
  `updateMemory` return `null`; `deleteChat` / `deleteMemory` return a boolean.
  Callers must handle it — these are the signatures that make a silent no-op
  possible.
- **Types live in the `DB` namespace** — `DB.Chat`, `DB.Memory`,
  `DB.PersistenceData`. Reference those rather than restating the shape.

### The read-modify-write hazard

Every save reads the whole file, merges the other collection, and rewrites it:

```ts
export async function saveChats(chats: DB.Chat[]): Promise<void> {
  const memories = await loadMemories();   // <- re-read, so memories survive
  await fs.writeFile(DATA_FILE_PATH, JSON.stringify({ chats, memories }, null, 2));
}
```

This is last-write-wins with no locking. **Concurrent writes lose data.** When
adding a mutation, follow the existing shape — load, mutate, save the whole
collection — and don't write the file from anywhere outside this module.

If a third collection is ever added, both `saveChats` and `saveMemories` must
learn about it or they will silently drop it on write.

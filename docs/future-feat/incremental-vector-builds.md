# Incremental vector builds

Status: proposed, not built. Written from the conversation that added corpus
cache invalidation; the invalidation itself has shipped and is assumed here.

## Problem Statement

Adding a single email to the corpus costs a full re-embedding of the corpus.

`pnpm run build:vectors` embeds every chunk of every email unconditionally — 606
chunks today — and writes `data/email-vectors.json` from scratch. There is no
way to say "one email arrived, embed that one". The vector artifact is
all-or-nothing.

That has three consequences the developer feels:

- Ingesting one new email means paying for 606 embeddings and waiting for the
  whole corpus to go over the wire, for one chunk of new content.
- Because the cost is a batch cost, ingestion stays a batch operation. There is
  no path to "an email arrives, it becomes searchable" without the batch command
  in the middle.
- Since the corpus caches now invalidate on file change, an appended email makes
  the next semantic search throw on the vector fingerprint until that full
  rebuild runs. The rebuild being expensive makes the loud failure more
  expensive to clear than it should be.

At the current corpus size this is seconds and a fraction of a cent, so it is not
urgent. It becomes the blocking constraint the moment the corpus is large enough
that a rebuild is measured in minutes and dollars, or the moment ingestion wants
to be per-email rather than per-batch.

## Solution

The build reuses every committed vector whose chunk has not changed, and embeds
only the chunks that are new or whose text was edited.

The developer runs the same command with a flag:

```
pnpm run build:vectors --incremental
```

and sees what was reused rather than a silent saving:

```
chunks     607 (1 new, 606 reused from the committed artifact)
embedding 1 chunk…
```

The written artifact is byte-for-byte the artifact a full build would have
produced for the same corpus — same order, same fingerprint, same trust
properties — so nothing downstream can tell the difference, and a full rebuild
remains available and remains the default.

## User Stories

1. As a developer, I want to append an email to the corpus and rebuild the
   vectors without re-embedding every other email, so that ingesting one message
   costs one message.
2. As a developer, I want the incremental build to produce an artifact identical
   in structure and fingerprint to a full build of the same corpus, so that I
   never have to reason about which build wrote the file I am searching.
3. As a developer, I want a full rebuild to stay the default, so that the cheap,
   obvious, always-correct path is the one I get when I do not think about it.
4. As a developer, I want to ask for the incremental path explicitly with a flag,
   so that reuse — the only part of this that can be silently wrong — is
   something I opted into.
5. As a developer, I want the build to print how many chunks were reused and how
   many were embedded, so that a reuse count of "all of them" on a corpus I just
   changed is visible rather than inferred from a suspiciously fast run.
6. As a developer, I want an email whose body I edited to be re-embedded, so that
   a corrected message does not keep the vector of its earlier wording.
7. As a developer, I want an email I deleted from the corpus to lose its vector,
   so that the artifact does not accumulate embeddings for documents that no
   longer exist.
8. As a developer, I want reuse to be refused wholesale when the configured
   embedding model changed, so that a single artifact can never contain vectors
   from two models, which would be unrankable against each other.
9. As a developer, I want reuse refused when the configured dimensionality
   changed, for the same reason.
10. As a developer, I want the first incremental run against the current
    committed artifact to fall back to a full build, so that adopting this
    feature needs no migration step and no hand-edited data file.
11. As a developer, I want that fallback to say why it happened, so that "it
    embedded everything again" is explained rather than mysterious.
12. As a developer, I want the artifact's aggregate fingerprint to remain the
    thing search validates, so that this feature adds no new way for a stale
    artifact to be trusted at read time.
13. As a developer, I want the per-chunk digests to be ignored entirely when
    loading vectors for search, so that a build-time optimisation cannot become a
    read-time trust signal.
14. As a developer, I want the reuse decision to be a pure function over the
    loaded artifact and the current chunks, so that I can test every branch of it
    with inline fixtures and no API key.
15. As a developer, I want artifact assembly to be a pure function too, so that
    the ordering and fingerprinting rules are proven once rather than living
    inside a script nothing tests.
16. As a developer, I want the build script to remain a thin caller over those
    functions, so that the untested part of the system stays too simple to hide a
    bug.
17. As a developer, I want an incremental build to fail loudly if any chunk ends
    up with no vector, so that an assembly bug cannot write a short artifact that
    the corrupt-length check catches only later.
18. As a developer, I want the same reuse machinery to apply to the test-query
    artifact, so that adding one entry to `TEST_QUERIES` does not re-embed the
    others and there is not a second code path to maintain.
19. As a developer, I want a chunking-policy change to invalidate reuse for every
    affected chunk, so that a new splitting rule cannot leave vectors of the old
    passages behind.
20. As a developer, I want a change to the document-id scheme to invalidate reuse,
    so that vectors are never carried over to ids that no longer resolve to a
    document.
21. As a developer, I want the artifact to stay one packed base64 blob, so that
    this does not trade a build cost for a parse cost on every server start.
22. As a developer, I want the digest list to be a small fraction of the file, so
    that the reuse metadata does not meaningfully grow a five-megabyte artifact.
23. As a developer, I want the incremental path to work when chunks were added in
    the middle of the corpus rather than at the end, so that ordering is never a
    condition of the saving.
24. As a maintainer of the assistant, I want the loud fingerprint failure after
    appending an email to be cheap to clear, so that the design's preference for
    loud staleness over silent staleness stays affordable.
25. As a maintainer, I want the reuse rules stated in one module, so that a future
    second document source inherits them by construction rather than by copying
    the email source's build.
26. As a maintainer, I want this to change nothing about how search ranks, so that
    the change can be reviewed as a build concern and evaluated without a
    relevance eval.

## Implementation Decisions

### The artifact gains a parallel digest list

`VectorArtifact` currently records `model`, `dimensions`, an aggregate
`fingerprint`, an `ids` list and the packed `vectors` blob. It stores no per-chunk
text information, which is precisely what makes reuse impossible today: a chunk
id is positional (`email:<nativeId>#<n>`) and does not move when the text beneath
it is edited, so reusing by id alone would silently keep a stale vector for an
edited email.

The artifact gains `digests`, a list of per-chunk text digests parallel to `ids`.

- **Optional in the type.** An artifact without it is still valid and still
  loadable; it simply cannot be reused from. This is what makes the currently
  committed file work unchanged and removes any migration step.
- **Digest of the chunk text alone**, not of id-plus-text. The id is already the
  lookup key; folding it into the digest would only re-express the key.
- **Full-length SHA-256 hex, not truncated.** The digest list is a low
  five-figure number of bytes against a five-megabyte artifact, so truncating
  buys nothing worth reasoning about collisions for.

### Reuse is a pure decision, taken before any embedding

A new exported function in the vector-artifact module takes the loaded artifact
and the current chunk list and returns the vectors that may be carried over,
keyed by chunk id. It is the single home of the reuse policy:

- Returns nothing at all when the artifact has no `digests`, when its `model`
  differs from the configured model, or when its `dimensions` differ. These are
  whole-artifact disqualifications — a mixed-model artifact is not partially
  usable, it is unrankable.
- Otherwise returns an entry for each current chunk whose id is present in the
  artifact **and** whose text digest matches the digest recorded against that id.
- Says why it returned nothing, so the caller can print the reason rather than
  reporting a full rebuild with no explanation.

Everything else follows from this being a set difference: a deleted email's chunk
is simply absent from the current chunk list and its vector is never carried;
a re-chunked body produces different ids or different texts and misses; an
inserted email's chunk has no entry and is embedded.

### Assembly is a second pure function

A companion function builds a `VectorArtifact` from the current chunks and a
lookup from chunk id to vector. It owns the rules that must hold however the
vectors were obtained:

- Ordering is the current chunk order, so an incremental artifact is
  indistinguishable from a full one.
- The aggregate `fingerprint` is computed from the current chunks, unchanged in
  definition.
- `digests` is computed from the current chunk texts.
- A chunk with no vector in the lookup is an error, not a gap. Writing a short
  artifact would defer the failure to the corrupt-length check at load time,
  which reports the symptom rather than the cause.

The full build path uses this function too, so there is one assembler and not a
fast one and a careful one.

### The build script stays thin

The script keeps ownership of the things a script should own — argument parsing,
the embedder and its timeout, batching, progress output, writing files — and
gains no decision logic. Its incremental path is: read the existing artifact if
present, ask for the reusable vectors, embed the chunks that were not covered,
assemble, write.

The script reports the split (`n reused, m embedded`) unconditionally, because a
saving nobody can see is a saving nobody can sanity-check.

### Incremental is opt-in

A `--incremental` flag; the default remains a full rebuild. Reuse is the only
part of this feature that can be wrong in a way that produces a working search
returning subtly worse results, so it is asked for rather than assumed. The
tradeoff is accepted knowingly: on today's corpus a full rebuild is cheap enough
that the default costs almost nothing, and the flag is a one-word change when the
corpus is large enough for the default to hurt.

### Read-time trust is unchanged

The loader's contract does not move. `assertArtifactMatches` continues to
validate model, dimensions, the aggregate fingerprint and the packed length, and
continues to ignore `digests` entirely. The digests exist so that a *build* can
avoid work; they are never consulted to decide whether an artifact may be
searched. This keeps the number of things that can make a stale artifact look
fresh at exactly one, which is the property the fingerprint was introduced for.

### Both artifacts, one path

The test-query artifact is written by the same assembler, with the query strings
as both ids and texts. Reuse therefore applies to it for free and there is no
second implementation to keep in step.

## Testing Decisions

A good test here calls an exported function and asserts on what it returns. None
of these tests may reach the network, need an API key, or observe how many times
something was called — the reuse decision is a value, and it should be asserted
as one. Nothing asserts on the digest algorithm or on digest strings themselves;
tests assert on *what gets reused*, so the digest could be swapped for another
scheme without touching a test.

**Module under test:** the vector-artifact module, through the two new exported
functions, in the existing test file. The build script is not tested, which is
the reason for pushing all the logic out of it.

**Prior art:** the existing tests in that file are the pattern to follow — small
inline chunk fixtures of two or three entries, `assertArtifactMatches` exercised
once per rejection reason, and the encode/decode round trip using
`toBeCloseTo` for floats rather than exact equality. The "throws when the texts
still match but the id scheme has changed" test is the closest relative of what
is needed here, and its shape carries over directly.

**Cases the reuse function must cover:**

- An unchanged corpus reuses every chunk.
- A corpus with one appended chunk reuses all the others and leaves the new one
  uncovered.
- A chunk inserted in the middle is handled identically to one appended at the
  end — coverage is by id, not by position.
- An edited text under an unchanged id is not reused.
- A removed chunk is simply absent, and does not appear in the result.
- An artifact with no digest list reuses nothing, and reports that as the reason.
- A model mismatch reuses nothing, even where every id and digest matches.
- A dimension mismatch reuses nothing, on the same terms.

**Cases the assembler must cover:**

- Output order follows the current chunks, not the order of the supplied lookup.
- The fingerprint of an assembled artifact equals the fingerprint of the same
  chunks fingerprinted directly — the anchor that keeps incremental and full
  builds interchangeable.
- A missing vector throws rather than producing a short artifact.
- An artifact assembled from reused vectors round-trips through decode to the
  same floats it was given.

**One integration-flavoured assertion is worth its cost:** assemble an artifact,
plan a reuse against a corpus with one chunk changed, assemble again with a stub
vector for the miss, and assert the result passes `assertArtifactMatches` against
the new corpus. That is the whole feature's contract in one test and it needs no
network.

## Out of Scope

- **Runtime embedding.** Nothing here lets the server embed an email during a
  request or write to the vector artifact while running. Ingestion remains a
  command the developer runs; this only makes that command cheaper.
- **A vector database.** The artifact stays a committed file. This is an
  optimisation of how that file is produced, not a step toward external storage.
- **Watch mode**, or any automatic rebuild on corpus change. The invalidation
  that has already shipped means a rebuild is picked up without a restart; it
  does not mean the rebuild starts by itself.
- **Removing or weakening the aggregate fingerprint.** It stays exactly as it is.
- **Changing the chunking policy.** The feature must survive a chunking change by
  correctly refusing to reuse; it does not make one.
- **Changing how search ranks anything.** No BM25F weight, fusion, or rerank
  behaviour is touched, and the feature should be reviewable without a relevance
  eval.
- **Concurrent builds.** Two builds racing on the same artifact is not defended
  against, as it is not defended against today.
- **Per-source partial rebuilds.** Reuse is per chunk. When a second document
  source is registered, the build still assembles one artifact; splitting the
  artifact per source is a separate question.

## Further Notes

The saving is real but currently small: 606 chunks at the configured embedding
model is well under a minute and roughly half a cent, so on today's corpus this
feature buys convenience rather than money. It is worth building when one of two
things becomes true — the corpus grows by an order of magnitude, or ingestion
becomes something that happens per email rather than per batch. The second is the
more likely trigger, and it is the one that makes the flag's default worth
revisiting.

The corpus cache invalidation this was scoped alongside is already in place: the
email source stamps `data/emails.json` with `mtime:size`, drops its derived
caches together when the stamp moves, and reports that stamp as its
`DocumentSource` version so the search index rebuilds with it. The practical
consequence for this spec is that after an incremental build the new vectors are
picked up without a server restart, which is what makes a cheap rebuild worth
having.

There is a latent decision this spec deliberately does not take: whether a corpus
change with no rebuild should keep throwing at search time, or degrade to
lexical-only results. Making rebuilds cheap weakens the argument for the throw,
since the fix becomes trivial. It is worth revisiting once this exists, but it is
a change to the loader's contract and belongs in its own spec.

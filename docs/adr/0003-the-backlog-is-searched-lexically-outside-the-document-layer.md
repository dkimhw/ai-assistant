# The backlog is searched lexically, outside the document layer

The backlog is indexed with BM25 only, built directly on `bm25.ts` and
`tokenize.ts` rather than registered as a `DocumentSource` in `documents.ts`.
The semantic leg exists to bridge vocabulary mismatch, which is a property of
reading strangers' email and largely not of a conversation where both parties
share vocabulary because one of them copied the other's words.

## Consequences

Three things follow from staying out of the registry, and they are the reason for
it: the registry builds one pooled BM25 index whose field length statistics would
be skewed by a source with no subject field (a limitation `documents.ts` names
and defers); it memoises a fixed set of static corpora for the process lifetime,
where a backlog belongs to one chat and changes every turn; and everything it
adds — id minting, chunking, vectors, RRF fusion, reranking — is a stage this
corpus does not have.

Only `text` parts are indexed. Indexing tool output would put one 39 KB document
beside dozens of 100-byte ones and wreck the length normalisation BM25 depends
on, and it would make email reachable through a second, staler ranked path —
which is the reason `email-search-tool.ts` already strips retrievals out of its
rerank context.

The cost of being wrong is a parallel search path to merge back if the backlog
ever wants semantic ranking or fusion. The index is in-memory and per-chat, so it
dies with the chat, which is what we want: nothing about a deleted chat outlives
it.

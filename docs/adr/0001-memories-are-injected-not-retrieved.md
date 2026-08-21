# Memories are injected into the prompt, not retrieved

Every memory is rendered into the system prompt on every request, rather than
being ranked and fetched by a tool through `searchDocuments`. This repo contains
a hybrid BM25F + semantic + rerank pipeline built for the email corpus, so
pointing it at memories is the obvious move and it is the wrong one: memories
number in the tens rather than the hundreds, so the whole set costs less than the
prompt around it, and — decisively — a retrieved memory only arrives on turns
where the model thinks to go looking. The memories that matter most, like a
standing preference for British English, are needed exactly on the turns that
give the model no reason to search for them.

Consequences: memories are deliberately **not** a `DocumentSource` and never
enter the corpus registry, so a runtime-created memory cannot invalidate the
committed vector artifact. The cost of the decision is unbounded prompt growth,
which a warning threshold in `loadMemories` is there to surface; crossing it is
the signal to revisit this.

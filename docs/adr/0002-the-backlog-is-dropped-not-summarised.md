# The backlog is dropped, not summarised

A long chat cannot all be sent on every turn, so the assistant is shown a window
of the most recent messages and the rest becomes the backlog, recoverable only
by a search tool it has to choose to call. We considered injecting a manifest of
the dropped messages (one line each) or a rolling summary, and rejected both:
the manifest reintroduces the linear growth we are removing, and a summary is
lossy in exactly the unpredictable way that loses the detail worth recovering.

## Consequences

The assistant cannot tell a truncated conversation from a short one, so it will
sometimes ask the user to repeat something already said rather than search for
it. This is accepted: the user supplies the signal ("we talked about this
before") and the tool does the lookup. It is the failure mode ADR 0001 refused
for memories, taken deliberately here — a memory is needed on turns that give no
reason to look for it, whereas a backlog message is usually being referred to out
loud when it is needed.

Tool output is treated separately from prose, because it is roughly all of the
bytes and almost none of the meaning: one assistant message in the store is 39 KB
of search results. Only the most recent assistant message keeps its tool output;
older calls are stubbed down to what was called. Tool output is not searchable
either (see ADR 0003), so this makes it unrecoverable — but every tool here reads
from a corpus that is still on disk, so the model can call the tool again.

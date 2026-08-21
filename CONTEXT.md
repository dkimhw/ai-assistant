# AI Assistant

A personal assistant over the user's email corpus: a streaming chat that
retrieves from email, and a store of things the assistant should know about the
user across conversations.

## Language

**Memory**:
Something the assistant should know about the user, standing across every
conversation. Written either by the user or by the assistant on the user's
instruction.
_Avoid_: fact, note, preference, directive, context

**Corpus**:
The body of documents a retrieval tool ranks over. Email is the only one.
Memories are not a corpus — they are never ranked.

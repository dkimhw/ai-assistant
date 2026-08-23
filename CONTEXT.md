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
The body of documents a retrieval tool ranks over. The user's email is one; the
backlog of a single chat is the second. Memories are not a corpus
— they are never ranked.

**Window**:
The part of a chat the assistant is shown on a given turn: the most recent
stretch of it. The user always sees the whole chat; the window is what the
assistant sees.
_Avoid_: context window, buffer, recent messages

**Backlog**:
The part of a chat that has fallen outside the window. Still shown to the user,
out of the assistant's sight until it searches for it with `searchHistory`, and
gone for good when the chat is deleted.
_Avoid_: history, archive, older messages

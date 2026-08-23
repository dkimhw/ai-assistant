import type { MyMessage } from "@/app/api/chat/route";
import { buildBM25Index, searchBM25, type BM25Index } from "@/lib/search/bm25";

/**
 * The Backlog, made searchable: a BM25 index over one chat's own messages.
 *
 * The Window shows the model the most recent messages and drops the rest (see
 * `@/lib/chat-window`). Everything dropped is the Backlog, and without this it
 * is simply gone — the assistant asks the user to repeat something they already
 * said. This module is the corpus that makes it reachable again.
 *
 * It is built directly on `bm25.ts` and `tokenize.ts` and is deliberately *not*
 * a `DocumentSource`; it never touches `documents.ts`. See
 * `docs/adr/0003-the-backlog-is-searched-lexically-outside-the-document-layer.md`.
 * The short version: the semantic leg exists to bridge vocabulary mismatch,
 * which is a property of reading strangers' email and not of a conversation
 * where one party copied the other's words; and the registry's pooled index,
 * process-lifetime memoisation, chunking, vectors and fusion are all stages this
 * corpus does not have.
 *
 * Only `text` parts are indexed. A tool output beside a prose message is one
 * 39 KB document among dozens of 100-byte ones, which wrecks the length
 * normalisation BM25 depends on, and it would make email reachable by a second,
 * staler ranked path.
 *
 * No disk, no network: everything here works from the in-memory message array
 * the route already validated.
 */

/**
 * How many messages come back. Five, matching `searchEmails`, and for the same
 * reason: the model has to read what it gets, and a lexical index over a few
 * hundred short documents that cannot land the right message in five is not
 * going to land it in twenty. A starting value.
 */
export const SEARCH_HISTORY_RESULT_COUNT = 5;

/**
 * Per-hit character budget, ellipses included. Bounds one pathological turn — a
 * pasted document is a `text` part like any other — without cutting normal
 * conversational messages at all.
 */
export const SEARCH_HISTORY_TEXT_CHARACTERS = 600;

/**
 * How much of a long message to keep before the term that matched, so a snippet
 * arrives with its lead-in rather than starting mid-sentence.
 */
const SNIPPET_LEAD_IN_CHARACTERS = 100;

/**
 * How many chats keep an index in memory. Each one is small (a few hundred short
 * documents at most), but a server process serves every chat the user opens and
 * an unbounded map would hold every one of them for the process lifetime.
 *
 * Eviction is least-recently-used, so the chat being talked in stays indexed and
 * an evicted one costs a rebuild on its next search and nothing else.
 */
const HISTORY_INDEX_CACHE_LIMIT = 20;

/**
 * One matched message, as the model reads it.
 *
 * `messageId` is the chat's own id for the message, so a later phase — or a UI —
 * can locate it in the transcript. `position` is its index in the full chat,
 * which is what "you said this near the start" is built from in Phase 4; it is
 * kept on the hit now because the index is the only thing that knows it.
 */
export type ChatHistoryHit = {
  messageId: string;
  position: number;
  role: MyMessage["role"];
  text: string;
};

type IndexedMessages = {
  index: BM25Index;
  /** Keyed by the document id, which is the message's position as a string. */
  hits: Map<string, ChatHistoryHit>;
};

/**
 * The part of a message worth showing: the region around the first term that
 * matched, not the message's opening.
 *
 * The distinction only matters for long messages, and for those it is the whole
 * point. A pasted 5,000-character document is a `text` part like any other, and
 * it is exactly the kind of message a user asks about later — "what did that
 * paste say about the completion date". Cutting to the first 600 characters
 * returns a hit whose text does not contain the word it was returned for, which
 * is worse than returning nothing: the model either restates the wrong passage
 * or reads the search as failed.
 *
 * Ellipses mark both ends, the same mark `searchEmails` uses and with the same
 * meaning — there is more of this message than you are looking at.
 */
const snippet = (opts: { text: string; terms: string[] }): string => {
  const { text } = opts;
  if (text.length <= SEARCH_HISTORY_TEXT_CHARACTERS) return text;

  const haystack = text.toLowerCase();
  const positions = opts.terms
    .map((term) => haystack.indexOf(term))
    .filter((at) => at >= 0);

  // No position at all when the match was on a token the tokenizer produced and
  // the raw text does not contain literally — an email address split into its
  // component words, say. The opening is the right fallback there.
  const at = positions.length > 0 ? Math.min(...positions) : 0;

  const start = Math.max(0, at - SNIPPET_LEAD_IN_CHARACTERS);
  const leading = start > 0 ? "…" : "";
  // Budget both marks before slicing, so a snippet can never exceed the bound.
  const room = SEARCH_HISTORY_TEXT_CHARACTERS - leading.length - 1;
  const end = Math.min(text.length, start + room);
  const trailing = end < text.length ? "…" : "";

  return `${leading}${text.slice(start, end).trim()}${trailing}`;
};

/**
 * The prose of a message, and nothing else. Reasoning parts are left out along
 * with tool parts: they are the model's working, not what was said.
 */
const textOf = (message: MyMessage): string =>
  message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();

/**
 * One document per message, one field. There is no second field to weight — a
 * chat message has no subject line — so BM25F degenerates to BM25 here, which is
 * the right shape rather than a missing feature.
 *
 * Messages with no prose are not indexed at all. A document that is empty in
 * every field drags `avgFieldLength` down and makes every real message look
 * longer than average, which is a scoring change disguised as a no-op.
 */
export const buildChatHistoryIndex = (opts: {
  messages: MyMessage[];
}): IndexedMessages => {
  const hits = new Map<string, ChatHistoryHit>();

  const documents = opts.messages.flatMap((message, position) => {
    const text = textOf(message);
    if (text.length === 0) return [];

    const id = String(position);
    hits.set(id, { messageId: message.id, position, role: message.role, text });

    return [{ id, fields: { text } }];
  });

  return { index: buildBM25Index({ documents }), hits };
};

/**
 * Keyed by chat id, invalidated on the chat's message ids.
 *
 * The count alone is the obvious signal — messages are append-only, so appending
 * moves it — and it is not sufficient, because a chat id does not identify a
 * client. Two tabs open on the same chat, or a resend after an aborted turn the
 * client kept a message from, arrive at the same length carrying different
 * messages; keyed on the count, the second request would rank over the first
 * one's conversation and fail to find what the user actually sent. The ids are
 * what make the two distinguishable, so the ids are the key.
 *
 * It costs an O(n) string of ids against an O(n × tokens) tokenise, so the cache
 * still pays — but it pays *within* a turn, not across turns. A turn appends the
 * user's message and the assistant's reply, so the following request rebuilds
 * whatever this holds. What it actually serves is a second `searchHistory` call
 * in the same turn, and the bound below exists so a long-lived process does not
 * accumulate an entry per chat ever opened, not because the entries are
 * precious.
 */
const cache = new Map<string, { key: string; indexed: IndexedMessages }>();

const keyFor = (messages: MyMessage[]): string =>
  messages.map((message) => message.id).join(",");

const remember = (opts: {
  chatId: string;
  entry: { key: string; indexed: IndexedMessages };
}) => {
  // Delete before set so the insertion order the eviction below reads is
  // recency order, not first-seen order.
  cache.delete(opts.chatId);
  cache.set(opts.chatId, opts.entry);

  while (cache.size > HISTORY_INDEX_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
};

const indexFor = (opts: {
  chatId: string;
  messages: MyMessage[];
}): IndexedMessages => {
  const cached = cache.get(opts.chatId);
  const key = keyFor(opts.messages);

  if (cached && cached.key === key) {
    remember({ chatId: opts.chatId, entry: cached });
    return cached.indexed;
  }

  const indexed = buildChatHistoryIndex({ messages: opts.messages });
  remember({ chatId: opts.chatId, entry: { key, indexed } });

  return indexed;
};

/**
 * The chat's own messages, ranked against a query, best first.
 *
 * The message the search was prompted by — the last one, the user's current turn
 * — is never a hit. The model writes the query *from* that message, so it is a
 * short document containing every query term and it ranks at or near the top: a
 * slot in five spent handing the question back, and one fewer for the message
 * the tool exists to reach. It is excluded after ranking rather than before it,
 * so it still contributes to the corpus statistics it is genuinely part of.
 *
 * Hits that fall inside the Window but earlier than that are still returned.
 * They are not free — they cost a slot for something the model can already see —
 * but knowing which of them are in the Window means knowing the Window, and
 * that belongs with the rest of Phase 4's hit shape.
 *
 * Returns an empty array rather than throwing when nothing matches — a query
 * whose every term is absent from the conversation is an ordinary answer here,
 * not a failure.
 */
export const searchChatHistory = (opts: {
  chatId: string;
  messages: MyMessage[];
  query: string;
  limit?: number;
}): ChatHistoryHit[] => {
  const { index, hits } = indexFor(opts);
  const limit = opts.limit ?? SEARCH_HISTORY_RESULT_COUNT;
  const askedFrom = opts.messages.length - 1;

  return searchBM25({
    index,
    query: opts.query,
    // One spare, so dropping the current turn cannot silently shorten the
    // results below the cap the caller asked for.
    limit: limit + 1,
  }).flatMap((result) => {
    const hit = hits.get(result.id);
    if (!hit || hit.position === askedFrom) return [];

    return [{ ...hit, text: snippet({ text: hit.text, terms: result.matchedTerms }) }];
  }).slice(0, limit);
};

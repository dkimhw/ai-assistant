import type { MyMessage } from "@/app/api/chat/route";
import { buildBM25Index, searchBM25, type BM25Index } from "@/lib/search/bm25";
import { WINDOW_MESSAGE_COUNT } from "@/lib/chat-window";

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
 * How much of a long message to keep before the anchor, so a snippet arrives
 * with its lead-in rather than starting mid-sentence.
 */
const SNIPPET_LEAD_IN_CHARACTERS = 100;

/**
 * Per-neighbour character budget, deliberately a fraction of the hit's own.
 *
 * A neighbour is not a result — it is there to make one intelligible. "Yes, do
 * that" needs the question above it, and the question's opening is enough to
 * supply that. Five hits each carrying two full-length neighbours would triple
 * the tool's payload to answer a question nobody asked.
 */
export const SEARCH_HISTORY_NEIGHBOUR_CHARACTERS = 200;

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
 * A message next to the one that matched. Role and prose, nothing else: it is
 * context for reading the hit, not a result in its own right, and giving it an
 * id would invite the model to cite it as though it had been retrieved.
 */
export type ChatHistoryNeighbour = {
  role: MyMessage["role"];
  text: string;
};

/**
 * One matched message, as the model reads it.
 *
 * `messageId` is the chat's own id, so a UI could locate the message in the
 * transcript. Everything else on here exists because a bare matched message is
 * not usable on its own:
 *
 * - `before` and `after` are the messages either side of it. A hit on "yes, do
 *   that" says nothing; the question above it is the whole content. Absent at
 *   the ends of a chat, and absent when the adjacent message is a tool call with
 *   no prose in it.
 * - `turn` and `ofTurns` place it: "turn 3 of 47" tells the model this was said
 *   near the start, which is how it weighs a fact that may since have been
 *   revised. One-based, because that is how the sentence reads.
 * - `inWindow` says whether the model can already see this message. A hit inside
 *   the Window is not news, and one presented as though it were invites the
 *   model to announce a discovery the user can see it did not have to make.
 */
export type ChatHistoryHit = {
  messageId: string;
  turn: number;
  ofTurns: number;
  role: MyMessage["role"];
  text: string;
  inWindow: boolean;
  before?: ChatHistoryNeighbour;
  after?: ChatHistoryNeighbour;
};

/** What the index holds per message: identity and full prose, no presentation. */
type IndexedMessage = {
  messageId: string;
  position: number;
  role: MyMessage["role"];
  text: string;
};

type IndexedMessages = {
  index: BM25Index;
  /** Keyed by the document id, which is the message's position as a string. */
  hits: Map<string, IndexedMessage>;
  /**
   * Every message's prose by position, including the ones that are not
   * documents. A tool-only assistant message is not searchable, but it is still
   * somebody's neighbour, and the positions have to line up with the chat rather
   * than with the index for that to work.
   */
  prose: ChatHistoryNeighbour[];
};

/**
 * Every position at which `term` occurs in an already-lowercased haystack,
 * ascending. Overlapping occurrences are not a concern — query terms are
 * whole words out of the tokenizer, not patterns.
 */
const occurrencesOf = (haystack: string, term: string): number[] => {
  const positions: number[] = [];
  for (
    let at = haystack.indexOf(term);
    at >= 0;
    at = haystack.indexOf(term, at + term.length)
  ) {
    positions.push(at);
  }
  return positions;
};

/** Does an ascending `positions` list contain anything in `[start, end)`? */
const occursWithin = (opts: {
  positions: number[];
  start: number;
  end: number;
}): boolean => {
  const { positions, start, end } = opts;
  let low = 0;
  let high = positions.length;

  while (low < high) {
    const mid = (low + high) >> 1;
    if (positions[mid] < start) low = mid + 1;
    else high = mid;
  }

  return low < positions.length && positions[low] < end;
};

/**
 * The part of a message worth showing: the region of it carrying the most of
 * what the query matched on, not the message's opening and not the first term
 * that happened to appear.
 *
 * The distinction only matters for long messages, and for those it is the whole
 * point. A pasted 5,000-character document is a `text` part like any other, and
 * it is exactly the kind of message a user asks about later — "what did that
 * paste say about the completion date". Cutting to the first 600 characters
 * returns a hit whose text does not contain the word it was returned for, which
 * is worse than returning nothing: the model either restates the wrong passage
 * or reads the search as failed.
 *
 * Anchoring on the *first* matched term has the same failure one step in, and
 * shipped once: minutes headed "Date: 3 March 2026" whose completion date sits
 * 1,500 characters down answer "completion date" with the heading. So the
 * anchor is the densest window instead — each occurrence of each matched term
 * proposes a window, and the one holding the most matched terms wins, each term
 * weighted by its `idf` so a rare word outvotes a common one rather than being
 * outnumbered by it. With one term, or with terms too far apart to share a
 * window, it degrades to the rarest term's neighbourhood, which is the best
 * single point available. Ties go to the earliest window, so the output is
 * deterministic.
 *
 * `idf` comes from the same index that decided the message matched at all; the
 * function is passed in rather than the index so this stays a string operation.
 *
 * Ellipses mark both ends, the same mark `searchEmails` uses and with the same
 * meaning — there is more of this message than you are looking at.
 */
const snippet = (opts: {
  text: string;
  terms: string[];
  idf: (term: string) => number;
}): string => {
  const { text } = opts;
  if (text.length <= SEARCH_HISTORY_TEXT_CHARACTERS) return text;

  const haystack = text.toLowerCase();
  const matches = opts.terms
    .map((term) => ({
      weight: opts.idf(term),
      positions: occurrencesOf(haystack, term),
    }))
    // No position at all when the match was on a token the tokenizer produced
    // and the raw text does not contain literally — an email address split into
    // its component words, say.
    .filter((match) => match.positions.length > 0);

  // Both ellipses, budgeted before anything is sliced so a snippet can never
  // exceed the bound. Scoring uses the same width the slice will have, give or
  // take the leading mark on a window that starts at 0.
  const room = SEARCH_HISTORY_TEXT_CHARACTERS - 2;

  const scoreFrom = (start: number) =>
    matches.reduce(
      (total, match) =>
        occursWithin({ positions: match.positions, start, end: start + room })
          ? total + match.weight
          : total,
      0
    );

  // The opening is the right fallback when nothing was found literally.
  let start = 0;
  let best = -1;

  for (const match of matches) {
    for (const position of match.positions) {
      const candidate = Math.max(0, position - SNIPPET_LEAD_IN_CHARACTERS);
      const score = scoreFrom(candidate);
      if (score > best || (score === best && candidate < start)) {
        best = score;
        start = candidate;
      }
    }
  }

  const leading = start > 0 ? "…" : "";
  const end = Math.min(
    text.length,
    start + SEARCH_HISTORY_TEXT_CHARACTERS - leading.length - 1
  );
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
  const hits = new Map<string, IndexedMessage>();

  const documents = opts.messages.flatMap((message, position) => {
    const text = textOf(message);
    if (text.length === 0) return [];

    const id = String(position);
    hits.set(id, { messageId: message.id, position, role: message.role, text });

    return [{ id, fields: { text } }];
  });

  const prose = opts.messages.map((message) => ({
    role: message.role,
    text: textOf(message),
  }));

  return { index: buildBM25Index({ documents }), hits, prose };
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

/** A neighbour, cut short. Long enough to identify a question, not to answer one. */
const neighbourText = (text: string) =>
  text.length <= SEARCH_HISTORY_NEIGHBOUR_CHARACTERS
    ? text
    : `${text.slice(0, SEARCH_HISTORY_NEIGHBOUR_CHARACTERS - 1).trimEnd()}…`;

/**
 * The message at `at`, if it is one worth showing beside a hit.
 *
 * Three ways there is nothing to show, and they are all ordinary: the hit is at
 * the start or end of the chat, the adjacent message is the user's current turn
 * — the question the model has just read, which is not context for anything —
 * or the adjacent message is a tool call with no prose in it. An empty
 * neighbour is worse than an absent one, because the model reads it as the
 * conversation having said nothing there.
 */
const neighbourAt = (opts: {
  prose: ChatHistoryNeighbour[];
  at: number;
  askedFrom: number;
}): ChatHistoryNeighbour | undefined => {
  const { prose, at } = opts;
  if (at < 0 || at >= prose.length || at === opts.askedFrom) return undefined;

  const message = prose[at];
  if (!message || message.text.length === 0) return undefined;

  return { role: message.role, text: neighbourText(message.text) };
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
 * Hits inside the Window are marked *and* sorted behind the ones outside it.
 * Marking alone is what the model needs to avoid announcing a discovery it did
 * not make; sorting is what stops those hits eating the cap. The cap is the
 * whole budget — five of anything — and a message the model can already read
 * costs a slot to tell it something it knows. They are kept rather than dropped
 * because an empty result is a sentence the prompt will act on: "the
 * conversation does not contain that" is a lie when the answer was two messages
 * up, and a chat shorter than the Window would otherwise never return anything.
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
  windowSize?: number;
}): ChatHistoryHit[] => {
  const { index, hits, prose } = indexFor(opts);
  const limit = opts.limit ?? SEARCH_HISTORY_RESULT_COUNT;
  const windowSize = opts.windowSize ?? WINDOW_MESSAGE_COUNT;

  // The same weighting BM25 scored with, handed to `snippet` so the passage it
  // cuts is anchored on the terms that earned the match rather than on whichever
  // one appears first.
  const idf = (term: string) => {
    const df = index.df.get(term) ?? 0;
    return Math.log(1 + (index.docCount - df + 0.5) / (df + 0.5));
  };

  const ofTurns = opts.messages.length;
  const askedFrom = ofTurns - 1;
  // The same cut `windowMessages` makes, arrived at the same way, so "in the
  // Window" here means what it means to the route.
  const windowStart = Math.max(0, ofTurns - windowSize);

  const ranked = searchBM25({
    index,
    query: opts.query,
    // Enough candidates that the reordering below has something to reorder: in
    // the worst case every message the model can already see outranks the one
    // it cannot, and the current turn takes one more.
    limit: limit + windowSize + 1,
  }).flatMap((result): ChatHistoryHit[] => {
    const hit = hits.get(result.id);
    if (!hit || hit.position === askedFrom) return [];

    return [
      {
        messageId: hit.messageId,
        turn: hit.position + 1,
        ofTurns,
        role: hit.role,
        text: snippet({ text: hit.text, terms: result.matchedTerms, idf }),
        inWindow: hit.position >= windowStart,
        before: neighbourAt({ prose, at: hit.position - 1, askedFrom }),
        after: neighbourAt({ prose, at: hit.position + 1, askedFrom }),
      },
    ];
  });

  // Stable within each group, so relevance still decides the order among the
  // hits that are news and among the hits that are not.
  return [
    ...ranked.filter((hit) => !hit.inWindow),
    ...ranked.filter((hit) => hit.inWindow),
  ].slice(0, limit);
};

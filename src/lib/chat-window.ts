import type { MyMessage } from "@/app/api/chat/route";
import { isToolUIPart, type UIMessage } from "ai";

/**
 * The Window: the part of a chat the assistant is shown on a given turn.
 *
 * A chat has no ceiling on its length and the model's prompt does, so at some
 * point a conversation stops fitting and something has to be left out. This
 * module decides what. It is deliberately the whole of that decision: the route
 * calls it once, between validating the request and converting it for the model,
 * and everything else in the app continues to see the entire chat.
 *
 * That separation is the point. The Window is a *view for one model call*, not a
 * retention policy — the messages are still persisted, still rendered, and still
 * scrollable by the user. Nothing here deletes anything.
 *
 * What falls outside the Window is the Backlog, and for now it is simply gone
 * from the model's view: there is no manifest of it in the prompt and no summary
 * of it, so the assistant cannot tell a truncated conversation from a short one
 * and will sometimes ask the user to repeat something they already said. That is
 * a chosen trade rather than an oversight — see
 * `docs/adr/0002-the-backlog-is-dropped-not-summarised.md`. What the model has
 * instead is `searchHistory` (`@/lib/search/chat-history-tool`), which reaches
 * the Backlog on the user's signal; it is given the whole message list rather
 * than this module's output, for the obvious reason.
 */

/**
 * How many messages the model sees.
 *
 * Counted in messages rather than tokens. A token budget bounds the prompt more
 * precisely, but it costs a tokeniser and makes "what was in context" vary turn
 * to turn for reasons nobody can see; a message count is deterministic and can
 * be reasoned about from the transcript alone.
 *
 * That honesty depends on messages being roughly the same size, which is true of
 * prose and wildly untrue of tool output — one assistant message in the store is
 * 39 KB of search results, three hundred times the size of a typical user turn.
 * Bounding *that* is the next phase's job, and it is a separate rule rather than
 * a different unit here.
 *
 * Twenty is a starting value with no argument behind it beyond being roughly ten
 * exchanges: comfortably more than anyone scrolls back through, and small enough
 * that the behaviour actually gets exercised in normal use rather than lying
 * dormant until turn two hundred. Expect to tune it.
 */
export const WINDOW_MESSAGE_COUNT = 20;

/**
 * The most recent `size` messages, oldest first.
 *
 * Slicing at message boundaries is what keeps this safe. A tool call and its
 * result live in the *same* assistant `UIMessage` and are only split into a
 * separate assistant/tool pair by `convertToModelMessages`, so a cut between two
 * messages can never orphan a tool result from its call — the failure that makes
 * naive transcript truncation reject at the provider.
 *
 * Taking from the end also preserves the route's invariant that the last message
 * is the user's, without this needing to know about it.
 */
export const windowMessages = (opts: {
  messages: MyMessage[];
  size?: number;
}): MyMessage[] => {
  const size = opts.size ?? WINDOW_MESSAGE_COUNT;

  // `slice(-0)` is `slice(0)`, which returns everything — the exact opposite of
  // what a caller asking for nothing meant.
  if (size <= 0) return [];

  return opts.messages.slice(-size);
};

/**
 * What replaces a tool output that has aged out. Addressed to the model, since
 * it is the only reader — an absence it cannot explain is worse than an absence
 * it can, and every tool here reads a corpus that is still on disk.
 */
export const DROPPED_TOOL_OUTPUT_NOTE =
  "This tool's output is no longer in context. Call the tool again if you need it.";

/** Strings longer than this are a body, not a label. */
const OUTLINE_STRING_LIMIT = 80;

/**
 * One field of a tool output, reduced to something that says what was there
 * without being usable as an answer.
 *
 * Scalars survive because they are cheap and load-bearing: `totalMatches` is a
 * number the model may already have quoted to the user, and a count that
 * disappears from context is a count that gets re-derived wrongly from a list.
 * Arrays become their length, which is exactly the part the model must not
 * answer from and exactly the part it needs to know it once had.
 */
const outlineValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return `${value.length} items`;
  if (value === null || value === undefined) return value;
  if (typeof value === "object") return "dropped";
  if (typeof value === "string" && value.length > OUTLINE_STRING_LIMIT) {
    return `${value.length} characters`;
  }
  return value;
};

const outlineOutput = (output: unknown): unknown => {
  if (Array.isArray(output)) return `${output.length} items`;
  if (output === null || typeof output !== "object") return outlineValue(output);

  return Object.fromEntries(
    Object.entries(output).map(([key, value]) => [key, outlineValue(value)])
  );
};

/**
 * Tool output survives only on the most recent assistant message; everywhere
 * earlier it is replaced by a note and an outline.
 *
 * This is the second of the Window's two rules, and it is separate from the
 * first because the two are bounding different things. A message count is an
 * honest unit for prose, where messages are all roughly one size. It is a
 * useless unit for tool output, where one assistant message can carry a full
 * step ceiling's worth of search results — the store has one at 38 KB, three
 * hundred times a typical user turn — so twenty messages is a bound in name
 * only for exactly the chats that need one.
 *
 * Keeping the most recent one is what makes "what was the third result?" work
 * for a turn. Beyond that, tool output in *history* buys very little: during a
 * turn the model's results arrive from the live loop, not from the transcript.
 *
 * The state stays `output-available` deliberately. `input-available` looks like
 * the honest way to say "no output here", but `convertToModelMessages` drops the
 * result for that state and emits the call alone — an orphaned tool call, which
 * a provider rejects outright. `output-error` converts, but tells the model the
 * call *failed*, which is a lie it will act on. Replacing the value is the only
 * form that is both convertible and true.
 */
export const stubOldToolOutput = (opts: {
  messages: MyMessage[];
}): UIMessage[] => {
  let lastAssistantIndex = -1;
  opts.messages.forEach((message, index) => {
    if (message.role === "assistant") lastAssistantIndex = index;
  });

  return opts.messages.map((message, index): UIMessage => {
    if (index === lastAssistantIndex) return message;

    let stubbed = false;
    const parts = message.parts.map((part) => {
      if (!isToolUIPart(part) || part.state !== "output-available") return part;
      stubbed = true;
      return {
        ...part,
        output: {
          dropped: DROPPED_TOOL_OUTPUT_NOTE,
          outline: outlineOutput(part.output),
        },
      };
    });

    return stubbed ? { ...message, parts } : message;
  });
};

/**
 * A tool part left in `input-streaming` or `input-available` state — a turn
 * aborted between the model asking for a tool and the tool answering. It is
 * persisted (`onFinish` counts any non-text part as content worth keeping) and
 * then replayed on every later request, where `convertToModelMessages` emits the
 * call and no result, and the provider rejects the whole request. One aborted
 * turn otherwise bricks the chat it happened in.
 *
 * The Window bounds the damage — the bad message eventually scrolls out — but
 * "unusable for the next twenty messages" is not a fix. Dropped here rather than
 * with `convertToModelMessages`'s `ignoreIncompleteToolCalls`, so that the same
 * rule applies at both call sites and the reason for it lives beside the stub
 * that reasons about the same failure.
 */
const isIncompleteToolCall = (part: UIMessage["parts"][number]) =>
  isToolUIPart(part) &&
  (part.state === "input-streaming" || part.state === "input-available");

const dropIncompleteToolCalls = (opts: {
  messages: UIMessage[];
}): UIMessage[] =>
  opts.messages.map((message) =>
    message.parts.some(isIncompleteToolCall)
      ? { ...message, parts: message.parts.filter((p) => !isIncompleteToolCall(p)) }
      : message
  );

/**
 * The Window, whole: the recent messages, with the old tool output taken out of
 * them and any half-finished tool call dropped. This is what the chat model is
 * sent.
 */
export const prepareWindow = (opts: {
  messages: MyMessage[];
  size?: number;
}): UIMessage[] =>
  dropIncompleteToolCalls({
    messages: stubOldToolOutput({ messages: windowMessages(opts) }),
  });

/**
 * How much of a chat title generation sees.
 *
 * The opening, not the Window — those are opposite ends. A title names what a
 * conversation is *about*, which is set by the question that started it and not
 * by wherever the thread drifted to forty messages later.
 *
 * Normally this changes nothing: a title is generated once, for a chat that is
 * one message long. It matters in one case, which is real — a chat deleted from
 * the sidebar with its tab still open replays the client's entire history into
 * `createChat`, and that whole transcript, tool output and all, used to go to
 * the title model.
 *
 * One message, because that is the case being sized for. Taking only user
 * messages also means tool output cannot reach the title model at all, rather
 * than being stubbed on its way there.
 */
export const TITLE_MESSAGE_COUNT = 1;

export const openingMessages = (opts: {
  messages: MyMessage[];
  size?: number;
}): MyMessage[] => opts.messages.slice(0, opts.size ?? TITLE_MESSAGE_COUNT);

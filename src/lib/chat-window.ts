import type { MyMessage } from "@/app/api/chat/route";

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
 * `docs/adr/0002-the-backlog-is-dropped-not-summarised.md`. The search tool that
 * makes the Backlog reachable again arrives in a later phase.
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

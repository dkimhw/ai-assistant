import { tool } from "ai";
import { z } from "zod";
import type { MyMessage } from "@/app/api/chat/route";
import {
  searchChatHistory,
  SEARCH_HISTORY_RESULT_COUNT,
  type ChatHistoryHit,
} from "@/lib/search/chat-history";

/**
 * `searchHistory`: the tool that reads the part of this conversation the model
 * is no longer shown.
 *
 * The Window sends the model the most recent messages and drops the rest, so a
 * long chat loses its own beginning. Everything dropped is still persisted, and
 * this is how the model gets at it — a BM25 index over the chat's prose,
 * built per request from the message list the route already has.
 *
 * Two things live here and nowhere else: the Zod input schema and the
 * model-facing description. The ranking is `chat-history.ts`'s.
 *
 * It fires on the user's signal, not on the model's suspicion. There is no
 * manifest of the Backlog in the prompt and no summary of it (ADR 0002), so the
 * model cannot tell a truncated conversation from a short one — what it can tell
 * is that the user said "we talked about this before", and that is what the
 * description and the system prompt are written around.
 */

/** Written for the model, not for a reader of this file. */
export const SEARCH_HISTORY_TOOL_DESCRIPTION =
  "Search earlier messages in THIS conversation — what the user and you have " +
  "already said to each other. Long chats are truncated before they reach you: " +
  "you see only the most recent messages, and everything before that is missing " +
  "from your context but not from the chat. Use this when the user refers to " +
  "something already discussed — 'what did I say about', 'we talked about this " +
  "before', 'you told me earlier', 'the thing I mentioned' — instead of asking " +
  "them to repeat it. This does NOT search email: it cannot see a single " +
  "message neither of you has mentioned, so a question about what an email says " +
  "needs `searchEmails` even when the user says 'earlier'. Matching is by " +
  "keyword, so use the words the user themselves would have used. Returns at " +
  `most ${SEARCH_HISTORY_RESULT_COUNT} messages, or an empty array when the ` +
  "conversation contains nothing matching — which is a real answer, not a " +
  "failure. Each result carries the messages either side of it, so a reply like " +
  "'yes, do that' arrives with the question it answered; `turn N of M` says how " +
  "early in the conversation it was said, which matters when a later message " +
  "may have revised it. `inWindow: true` means that message is already in the " +
  "part of the conversation you can see — it is not something you have just " +
  "discovered, so do not present it as one. ALWAYS restate what you recover in " +
  "your own reply: this result is not part of the conversation and will be gone " +
  "from your context next turn, so a fact you leave sitting in it has to be " +
  "found all over again.";

export const searchHistoryInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "The words to look for in the conversation. This is keyword matching " +
        "over what was actually typed, not a semantic search — use the user's " +
        "own nouns and names rather than a paraphrase of them."
    ),
});

export type SearchHistoryInput = z.infer<typeof searchHistoryInputSchema>;

export type SearchHistoryOutput = ChatHistoryHit[];

/**
 * Takes the chat rather than reaching for it: this corpus is one request's
 * message array, not a file on disk, and the route is the only thing holding it.
 *
 * It is the *whole* validated list, deliberately — the Window has not been
 * applied to it. Applying the Window here would leave the tool able to search
 * only what the model can already see, which is the one thing it is not for.
 *
 * Both fields are optional because `chatTools` builds an unbound copy of the set
 * for `safeValidateUIMessages`, which only ever reads schemas. That copy answers
 * every query with an empty array, which is the honest answer for a tool holding
 * no conversation.
 */
export const createSearchHistoryTool = (opts?: {
  chatId?: string;
  messages?: MyMessage[];
}) =>
  tool({
    description: SEARCH_HISTORY_TOOL_DESCRIPTION,
    inputSchema: searchHistoryInputSchema,
    execute: async ({ query }): Promise<SearchHistoryOutput> => {
      if (!opts?.chatId || !opts.messages) return [];

      return searchChatHistory({
        chatId: opts.chatId,
        messages: opts.messages,
        query,
      });
    },
  });

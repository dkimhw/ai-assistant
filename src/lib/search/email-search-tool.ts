import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import type { RankedChunk } from "@/lib/search/documents";
import { searchEmails } from "@/lib/search/emails";
import type { Embedder } from "@/lib/search/embedder";
import { createOpenAIReranker, type Reranker } from "@/lib/search/reranker";

/**
 * The email search tool the chat model calls, over the same hybrid BM25F +
 * semantic + RRF pipeline the search page uses. No second ranker, no second set
 * of field weights: tuning the search layer improves both surfaces at once.
 *
 * Two things live here and nowhere else — the Zod input schema and the
 * model-facing description text — so tuning retrieval behaviour is a text edit.
 *
 * Server-only: `searchEmails` reads `data/*.json` from disk. Do not import from
 * a client component.
 */

/**
 * Fixed, not a tool parameter. A result count the model can choose is a decision
 * it has to make on every call — attention spent on list length rather than on
 * writing a good query — and with a sensible default and a hard cap the two
 * would sit close enough together to buy almost nothing.
 *
 * Five is also the honest number: the model has to actually read what comes
 * back, and a hybrid ranker that cannot land the right email in five tries has a
 * relevance problem a longer list papers over. Bounding it here bounds the
 * worst-case payload, token spend, and cost of one confused turn. Raise it when
 * there is an eval that can say whether raising it helped.
 */
export const EMAIL_SEARCH_RESULT_COUNT = 5;

/**
 * Per-result body budget, ellipsis included. The corpus's longest body is ~6600
 * characters, so five untruncated results could dominate the context window on
 * their own. Generous enough that most emails arrive whole.
 *
 * Mostly a hard bound rather than the working limit it once was: a result now
 * carries the passage that matched, and the chunking policy sizes most of those
 * well under it — of 606 chunks the median is 512 characters and 17 exceed this
 * budget. It still bites on those 17, and on the whole bodies a result falls
 * back to when reranking did not run.
 */
export const EMAIL_SEARCH_BODY_CHARACTERS = 1200;

/**
 * How many recent messages are shown to the reranker, most recent last —
 * roughly three exchanges.
 *
 * Enough to resolve "that one" and "the deadline on that"; short enough that a
 * rerank prompt cannot grow with the length of the chat, and that a change of
 * subject is not dragged back towards the previous one. A starting position to
 * tune against evals, and the second knob worth tuning after the candidate pool.
 */
export const EMAIL_SEARCH_HISTORY_MESSAGES = 6;

/**
 * Per-message budget for that history. Bounding the number of messages is not
 * enough to bound the prompt: one pasted document in a user turn would be
 * carried whole into every rerank call for the rest of the conversation, and a
 * prompt that outgrows the model's context fails the whole stage.
 *
 * What the reranker needs from a turn is its subject matter — enough to resolve
 * "that one" — which is near the start of a message far more often than not.
 */
export const EMAIL_SEARCH_HISTORY_CHARACTERS = 400;

/**
 * Written for the model, not for a reader of this file.
 */
export const EMAIL_SEARCH_TOOL_DESCRIPTION =
  "Search the user's email corpus and return the most relevant emails, best first. " +
  "Use this for any question about emails, people, amounts, dates, or specific " +
  "details the user may have been told. Search is hybrid — the query is matched " +
  "both by keyword and by meaning — so one well-chosen query serves both. Returns " +
  `at most ${EMAIL_SEARCH_RESULT_COUNT} emails, or an empty array when nothing matches.`;

export const emailSearchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "The search query, which you write rather than the user. Rephrase the " +
        "user's question as search terms: keep their natural phrasing and " +
        "include the specific names, amounts, and nouns they used. If a search " +
        "comes back empty or irrelevant, call again with different terms."
    ),
});

export type EmailSearchInput = z.infer<typeof emailSearchInputSchema>;

/**
 * The smallest shape that supports citation. The id is here so the model can
 * refer to an email unambiguously and a future UI can link to it; sender and
 * subject are what a citation is written from. The fused RRF score is
 * deliberately absent — it has no absolute meaning, and inviting the model to
 * reason about it invites nonsense.
 */
export type EmailSearchResult = {
  id: string;
  subject: string;
  from: string;
  timestamp: string;
  body: string;
};

/**
 * Shared with the filter tool rather than reimplemented there: one budget, one
 * ellipsis, so a body the model sees is cut the same way whichever tool found
 * it. `getEmails` deliberately does not use this — see `email-get-tool.ts`.
 */
export const truncateBody = (text: string, opts?: { limit?: number }) => {
  const limit = opts?.limit ?? EMAIL_SEARCH_BODY_CHARACTERS;
  return text.length <= limit
    ? text
    : `${text.slice(0, limit - 1).trimEnd()}…`;
};

/**
 * What the model is shown for one result: the passage that won, or the body's
 * opening when reranking did not run.
 *
 * A passage with more of the email after it ends in an ellipsis, the same mark
 * truncation uses, because from the model's side the two mean the same thing —
 * there is more of this email than you are looking at, call `getEmails`. That a
 * passage may also *begin* mid-email is stated in the system prompt rather than
 * marked here: a leading ellipsis would sit in front of the subject line the
 * chunking policy prepends, where it reads as a truncated subject.
 */
const passageOf = (opts: {
  chunk?: RankedChunk;
  body: string;
}): string => {
  const { chunk, body } = opts;
  if (!chunk) return truncateBody(body);

  const isLast = chunk.index === chunk.count - 1;
  // Budget the mark before truncating, so a passage can never exceed the bound.
  const text = truncateBody(chunk.text, {
    limit: isLast ? undefined : EMAIL_SEARCH_BODY_CHARACTERS - 1,
  });

  return isLast || text.endsWith("…") ? text : `${text}…`;
};

/**
 * The conversation the reranker is allowed to see: the text of recent user and
 * assistant messages, most recent last.
 *
 * Tool calls and tool results are dropped deliberately, and this is the one
 * place that rule lives. They are bulky, they are already summarised by the
 * assistant's reply, and feeding a retrieval system its own previous retrievals
 * is how a conversation gets stuck in one neighbourhood of the corpus. The
 * system prompt is dropped for the same reason it is not a turn: it is
 * instructions, not context about what is being discussed.
 */
const conversationContext = (opts: {
  messages: ModelMessage[];
}): string[] =>
  opts.messages
    .flatMap((message) => {
      if (message.role !== "user" && message.role !== "assistant") return [];

      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n");

      // An assistant turn that was nothing but a tool call has no prose to add.
      if (text.trim().length === 0) return [];

      return [
        `${message.role === "user" ? "User" : "Assistant"}: ${truncateBody(
          text.trim(),
          { limit: EMAIL_SEARCH_HISTORY_CHARACTERS }
        )}`,
      ];
    })
    .slice(-EMAIL_SEARCH_HISTORY_MESSAGES);

/**
 * The configured reranker, or none if there isn't one.
 *
 * Resolved per call rather than at import time — where a missing key would take
 * down the whole tool set — and a failure to resolve one degrades exactly as a
 * failure to *use* one does. Every other stage of this pipeline keeps working
 * when its provider is unavailable, and "no API key" is the most likely way for
 * that to happen: a dev or eval environment without one should still get
 * lexical results rather than a tool error.
 */
const configuredReranker = (): Reranker | undefined => {
  try {
    return createOpenAIReranker();
  } catch (error) {
    console.warn(
      "[search] no reranker configured, ranking without one:",
      error instanceof Error ? error.message : error
    );
    return undefined;
  }
};

/**
 * Takes the embedder and reranker rather than reaching for them, so tests
 * exercise the real ranker over the real corpus without a network call. Both are
 * omitted in production, where each is resolved from the environment and each
 * degrades on its own if that fails.
 */
export const createEmailSearchTool = (opts?: {
  embedder?: Embedder;
  reranker?: Reranker;
}) =>
  tool({
    description: EMAIL_SEARCH_TOOL_DESCRIPTION,
    inputSchema: emailSearchInputSchema,
    execute: async ({ query }, { messages }): Promise<EmailSearchResult[]> => {
      const results = await searchEmails({
        query,
        limit: EMAIL_SEARCH_RESULT_COUNT,
        embedder: opts?.embedder,
        reranker: opts?.reranker ?? configuredReranker(),
        rerankContext: conversationContext({ messages }),
      });

      return results.map(({ email, chunk }) => ({
        id: email.id,
        subject: email.subject,
        from: email.from,
        timestamp: email.timestamp,
        body: passageOf({ chunk, body: email.body }),
      }));
    },
  });

import { tool } from "ai";
import { z } from "zod";
import { searchEmails } from "@/lib/search/emails";
import type { Embedder } from "@/lib/search/embedder";

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
 */
export const EMAIL_SEARCH_BODY_CHARACTERS = 1200;

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
 * Takes the embedder rather than reaching for one, so tests exercise the real
 * ranker over the real corpus without a network call. Omitted in production,
 * where `searchEmails` resolves the configured OpenAI embedder itself — and
 * degrades to lexical-only if that call fails.
 */
export const createEmailSearchTool = (opts?: { embedder?: Embedder }) =>
  tool({
    description: EMAIL_SEARCH_TOOL_DESCRIPTION,
    inputSchema: emailSearchInputSchema,
    execute: async ({ query }): Promise<EmailSearchResult[]> => {
      const results = await searchEmails({
        query,
        limit: EMAIL_SEARCH_RESULT_COUNT,
        embedder: opts?.embedder,
      });

      return results.map(({ email }) => ({
        id: email.id,
        subject: email.subject,
        from: email.from,
        timestamp: email.timestamp,
        body: truncateBody(email.body),
      }));
    },
  });

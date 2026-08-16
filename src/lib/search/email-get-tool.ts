import { tool } from "ai";
import { z } from "zod";
import {
  getEmailById,
  getThreadEmails,
  type Email,
} from "@/lib/search/emails";

/**
 * The email fetch tool the chat model calls. It retrieves, it does not search:
 * every id it takes is one the model has already seen from `searchEmails` or
 * `filterEmails`, and it returns those emails in full.
 *
 * It exists because both of the other tools truncate. The corpus's longest body
 * is 6660 characters against a 1200-character budget, so an answer can sit past
 * the cut with no way to reach it — the model either answers from the fragment
 * or re-searches and gets the same fragment back. `expandThread` covers the
 * other half of that: a reply saying "yes, that works" ranks perfectly well
 * alone and means nothing without the message it answers.
 *
 * No query parameter, deliberately. A third way to search would hand the model
 * back the result-count decision the search tool took away from it, and there is
 * no question it would answer that search-then-fetch does not.
 *
 * Two things live here and nowhere else — the Zod input schema and the
 * model-facing description text.
 *
 * Server-only: reads `data/emails.json` from disk. Do not import from a client
 * component.
 */

/**
 * A bound on one call, enforced at the schema so the model is told to ask again
 * with fewer rather than left believing it read everything.
 *
 * The bound is on ids rather than characters on purpose: the guarantee this tool
 * makes is that what it returns *is* the email, and a body budget here would
 * reintroduce the exact problem it was built to remove. Five untruncated bodies
 * at the corpus's longest is ~33k characters, which is a worst case worth
 * bounding and not one worth fearing. Threads make it at most four times that,
 * and this corpus's threads run to four short messages.
 */
export const EMAIL_GET_MAX_IDS = 5;

/** Written for the model, not for a reader of this file. */
export const EMAIL_GET_TOOL_DESCRIPTION =
  "Fetch emails in full by their ids, using ids returned by searchEmails or " +
  "filterEmails — this tool cannot find emails, only retrieve ones you have " +
  "already seen. Search and filter results are truncated; these are not. Call " +
  "this before quoting an email, before reasoning about its detail, and whenever " +
  "a body you were given ends in an ellipsis. Set expandThread to also get every " +
  "other message in the same conversation, oldest first, which is what makes a " +
  `short reply legible. At most ${EMAIL_GET_MAX_IDS} ids per call. Ids that ` +
  "match no email come back in `missingIds` — if one of yours is listed there, " +
  "you invented it; search again rather than guessing another.";

export const emailGetInputSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1)
    .max(EMAIL_GET_MAX_IDS)
    .describe(
      "The ids of the emails to fetch, exactly as they appeared in an earlier " +
        "searchEmails or filterEmails result. Never invent one."
    ),
  expandThread: z
    .boolean()
    .describe(
      "When true, return every message in each email's thread rather than just " +
        "the email itself. Use it when a message reads as a reply, or when you " +
        "need the shape of a conversation rather than one turn of it."
    )
    .optional(),
});

export type EmailGetInput = z.infer<typeof emailGetInputSchema>;

/**
 * The search tool's fields, plus `to`, plus `threadId` — the latter so the model
 * can tell a standalone message from one turn of an exchange and say so. `body`
 * is the email's body, untruncated. No score: nothing here was ranked.
 */
export type EmailGetResult = {
  id: string;
  subject: string;
  from: string;
  to: string;
  timestamp: string;
  threadId: string;
  body: string;
};

/**
 * `missingIds` carries the ids that matched nothing. Dropping them silently
 * would leave a hallucinated id indistinguishable from an email with nothing in
 * it, and the model with no way to tell that it should search instead.
 */
export type EmailGetOutput = {
  emails: EmailGetResult[];
  missingIds: string[];
};

const toResult = (email: Email): EmailGetResult => ({
  id: email.id,
  subject: email.subject,
  from: email.from,
  to: email.to,
  timestamp: email.timestamp,
  threadId: email.threadId,
  body: email.body,
});

export const createEmailGetTool = () =>
  tool({
    description: EMAIL_GET_TOOL_DESCRIPTION,
    inputSchema: emailGetInputSchema,
    execute: async ({ ids, expandThread }): Promise<EmailGetOutput> => {
      const missing = new Set<string>();
      // Grouped by thread, and keyed by id within it, so two ids in one thread —
      // or the same id twice — yield each email exactly once. Grouping is what
      // keeps two expanded threads from interleaving: sorting everything by
      // timestamp alone would deal the conversations together like two halves of
      // a shuffled deck, and leave `threadId` as the only way to tell them
      // apart.
      const threads = new Map<string, Map<string, Email>>();

      for (const id of ids) {
        const email = getEmailById(id);

        if (!email) {
          missing.add(id);
          continue;
        }

        const members = expandThread
          ? getThreadEmails({ threadId: email.threadId })
          : [email];

        const thread = threads.get(email.threadId) ?? new Map<string, Email>();
        threads.set(email.threadId, thread);
        for (const member of members) thread.set(member.id, member);
      }

      // Threads in the order they were first asked for; within each, oldest
      // first, so a conversation reads in the order it happened.
      const emails = [...threads.values()].flatMap((thread) =>
        [...thread.values()].sort((a, b) =>
          a.timestamp.localeCompare(b.timestamp)
        )
      );

      return { emails: emails.map(toResult), missingIds: [...missing] };
    },
  });

import { tool } from "ai";
import { z } from "zod";
import {
  EMAIL_SEARCH_BODY_CHARACTERS,
  truncateBody,
} from "@/lib/search/email-search-tool";
import { getAllEmails, type Email } from "@/lib/search/emails";

/**
 * The email filter tool the chat model calls. A predicate over the corpus, not a
 * ranker: no query, no BM25, no embeddings, no scores. Where `searchEmails`
 * answers "what did someone say about X", this answers "which emails match these
 * facts" — and answers it exactly.
 *
 * Two things live here and nowhere else — the Zod input schema and the
 * model-facing description text — so tuning which tool the model reaches for is
 * a text edit.
 *
 * Server-only: reads `data/emails.json` from disk. Do not import from a client
 * component.
 */

/**
 * Fixed, not a tool parameter, for the same reason the search tool's count is:
 * a number the model can choose is a decision it has to make every call.
 *
 * Ten rather than search's five, because these are different things. Five search
 * results are a ranker's best guesses, and a model that cannot find the answer
 * in five has a relevance problem a longer list papers over. Ten filter results
 * are a slice of a set the user asked to see, where the honest failure is
 * showing too few. `totalMatches` is what keeps that slice honest, so the cap
 * bounds the payload without costing the model the truth about the set.
 */
export const EMAIL_FILTER_RESULT_COUNT = 10;

/**
 * Written for the model, not for a reader of this file. The contrast with
 * `searchEmails` is stated here rather than left to be inferred: two tools over
 * one corpus mean the failure mode to design against is reaching for the wrong
 * one, and `contains` is the specific trap — it is a literal substring test, and
 * a model that treats it as a cheap search gets emptiness where the ranker would
 * have found the answer.
 */
export const EMAIL_FILTER_TOOL_DESCRIPTION =
  "Filter the user's emails by exact criteria: sender, recipient, date range, or " +
  "an exact string they contain. Use this when the question is about who, to whom, " +
  "when, or how many — 'emails from John', 'anything before March', 'how many did " +
  "the solicitor send' — and use searchEmails instead when the question is about " +
  "what an email said or meant. `contains` is an exact substring test, not a " +
  "search: use it for reference numbers and literal strings, never for topics. " +
  "Give at least one criterion — a call with none is an error, not a request for " +
  "every email. Criteria combine with AND. Returns the true total number of " +
  "matches alongside " +
  `at most ${EMAIL_FILTER_RESULT_COUNT} emails, newest first — so say how many ` +
  "there are from `totalMatches`, not from how many emails came back.";

/**
 * Accepts `YYYY-MM-DD` or an ISO-8601 datetime, and nothing else. A model asked
 * for a date will otherwise offer "last tuesday" or "June 2024", and a boundary
 * that silently fails to parse is a filter that silently matches everything —
 * the failure this rejects at the door.
 *
 * The timezone designator is optional, and its absence means UTC. JavaScript
 * reads a bare `2024-06-01T09:00:00` as *local* time while reading a bare
 * `2024-06-01` as UTC, which would put the two forms hours apart for the same
 * intended instant; `asUtc` below removes that difference rather than leaving it
 * to surprise someone. A model that emits a datetime usually emits it without a
 * zone, so rejecting the form outright would cost a wasted step to discover.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_BOUNDARY =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const HAS_TIMEZONE = /(Z|[+-]\d{2}:\d{2})$/;

/** A datetime with no zone is UTC, matching how the date-only form parses. */
const asUtc = (value: string) =>
  ISO_DATE.test(value) || HAS_TIMEZONE.test(value) ? value : `${value}Z`;

/**
 * The shape check is a `.regex`, not a `.refine`, because only the former
 * survives into the JSON Schema the model is shown — a refinement is invisible
 * to it, and an invisible rule can only be discovered by breaking it. The
 * `.refine` that follows catches what a pattern cannot: `2024-13-45` is
 * well-formed and not a date.
 */
const boundary = (opts: { description: string }) =>
  z
    .string()
    .regex(ISO_BOUNDARY, "expected YYYY-MM-DD or an ISO-8601 datetime")
    .refine((value) => !Number.isNaN(Date.parse(asUtc(value))), {
      message: "not a real date",
    })
    .describe(opts.description)
    .optional();

const criterion = (opts: { description: string }) =>
  z.string().min(1).describe(opts.description).optional();

export const emailFilterInputSchema = z
  .object({
    from: criterion({
      description:
        "Filter by sender. Matched as a case-insensitive substring of the " +
        "sender's address, so a first name or a company's domain both work.",
    }),
    to: criterion({
      description:
        "Filter by recipient, matched the same way as `from`. An email with " +
        "several recipients matches on any one of them.",
    }),
    after: boundary({
      description:
        "Only emails at or after this point. `YYYY-MM-DD` means the start of " +
        "that day; an ISO-8601 datetime is used as given, and counts as UTC " +
        "unless it carries a timezone. Inclusive.",
    }),
    before: boundary({
      description:
        "Only emails at or before this point. `YYYY-MM-DD` means the END of " +
        "that day, so a single date in both `after` and `before` gives you that " +
        "whole day. A datetime counts as UTC unless it carries a timezone. " +
        "Inclusive.",
    }),
    contains: criterion({
      description:
        "Only emails whose subject or body contains this exact string, " +
        "case-insensitive. Literal — not a search. Use searchEmails for topics.",
    }),
  })
  .refine(
    (criteria) => Object.values(criteria).some((value) => value !== undefined),
    {
      // The rule is invisible to the model: a `.refine` does not survive into
      // the JSON Schema the way a `.regex` does, so the only way to find it is
      // to break it — and breaking it costs a step out of a bounded turn.
      //
      // The message is therefore written as a recovery instruction rather than
      // as a complaint. "give at least one criterion" tells a model what it did
      // wrong and leaves it to guess the fix, which is how one wasted step
      // becomes two; naming the fields and naming the alternative tool lets the
      // next call be right. The cost of a rule that can only be discovered by
      // failing is at least bounded at a single failure.
      message:
        "filterEmails needs at least one of `from`, `to`, `after`, `before`, " +
        "or `contains`. It has no 'everything' mode. If you wanted a general " +
        "look at recent email, pass an `after` date; if you were searching for " +
        "a topic, use searchEmails instead.",
    }
  );

export type EmailFilterInput = z.infer<typeof emailFilterInputSchema>;

/**
 * The search tool's result fields plus `to`: a recipient is a thing you can
 * filter on here, so it is a thing you should be able to see you filtered on.
 * No score — there is no ranking to report.
 */
export type EmailFilterResult = {
  id: string;
  subject: string;
  from: string;
  to: string;
  timestamp: string;
  body: string;
};

/**
 * `totalMatches` is the whole point of the tool, and the reason this returns an
 * object where the search tool returns a bare array. It counts matches *before*
 * the cap, so "you have 14 emails from the solicitor" is a fact the model reads
 * rather than a guess it makes from the length of a truncated list.
 */
export type EmailFilterOutput = {
  totalMatches: number;
  emails: EmailFilterResult[];
};

const includesFold = (opts: { haystack: string; needle: string }) =>
  opts.haystack.toLowerCase().includes(opts.needle.toLowerCase());

/**
 * A bare `YYYY-MM-DD` covers the whole day: the start of it for `after`, the end
 * of it for `before`. Anything else — a full datetime — is used as given.
 *
 * The alternative, treating a bare date as midnight at both ends, makes
 * `before: "2024-06-01"` exclude everything actually sent on the 1st. That is
 * the kind of off-by-one nobody notices in an answer, which is why it is spelled
 * out here and pinned by a boundary test.
 */
const boundaryMs = (opts: { value: string; edge: "start" | "end" }) =>
  Date.parse(
    ISO_DATE.test(opts.value) && opts.edge === "end"
      ? `${opts.value}T23:59:59.999Z`
      : asUtc(opts.value)
  );

/**
 * The body as the model should see it.
 *
 * Ordinarily that is the first `EMAIL_SEARCH_BODY_CHARACTERS` characters, same
 * as a search result. But `contains` matches the *whole* body while the payload
 * carries a truncated one, so a match past the budget arrives as an email that
 * visibly does not contain the string it was filtered on — the model's only
 * reasonable conclusion being that the filter is broken. 16 of this corpus's 547
 * bodies are long enough for that to happen.
 *
 * So when the match falls past the cut, the window slides to hold it, opening
 * with an ellipsis to say that it did. The match sits about a third of the way
 * in, which leaves the sentence it is in readable from both sides.
 */
const bodyFor = (opts: { body: string; contains?: string }) => {
  const { body, contains } = opts;

  if (!contains) return truncateBody(body);

  const at = body.toLowerCase().indexOf(contains.toLowerCase());

  // Either the subject was what matched, or the match is already visible.
  if (at === -1 || at + contains.length <= EMAIL_SEARCH_BODY_CHARACTERS) {
    return truncateBody(body);
  }

  const start = Math.max(0, at - Math.floor(EMAIL_SEARCH_BODY_CHARACTERS / 3));

  // The leading ellipsis is one of the budget's characters, not an extra one.
  return `…${truncateBody(body.slice(start), {
    limit: EMAIL_SEARCH_BODY_CHARACTERS - 1,
  })}`;
};

const matches = (opts: { email: Email; criteria: EmailFilterInput }) => {
  const { email, criteria } = opts;

  if (criteria.from && !includesFold({ haystack: email.from, needle: criteria.from }))
    return false;

  // Multiple recipients are one comma-separated string in this corpus, so a
  // substring test gives per-recipient matching for free. A future structured
  // `to` needs to preserve that.
  if (criteria.to && !includesFold({ haystack: email.to, needle: criteria.to }))
    return false;

  if (
    criteria.contains &&
    !includesFold({
      haystack: `${email.subject}\n${email.body}`,
      needle: criteria.contains,
    })
  )
    return false;

  const sentAt = Date.parse(email.timestamp);

  if (
    criteria.after &&
    sentAt < boundaryMs({ value: criteria.after, edge: "start" })
  )
    return false;

  if (
    criteria.before &&
    sentAt > boundaryMs({ value: criteria.before, edge: "end" })
  )
    return false;

  return true;
};

export const createEmailFilterTool = () =>
  tool({
    description: EMAIL_FILTER_TOOL_DESCRIPTION,
    inputSchema: emailFilterInputSchema,
    execute: async (criteria): Promise<EmailFilterOutput> => {
      const matched = getAllEmails().filter((email) =>
        matches({ email, criteria })
      );

      // Newest first: the most recent state of a conversation is what a reader
      // wants at the top, and it makes the cap drop the stalest matches.
      matched.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

      return {
        totalMatches: matched.length,
        emails: matched
          .slice(0, EMAIL_FILTER_RESULT_COUNT)
          .map(({ id, subject, from, to, timestamp, body }) => ({
            id,
            subject,
            from,
            to,
            timestamp,
            body: bodyFor({ body, contains: criteria.contains }),
          })),
      };
    },
  });

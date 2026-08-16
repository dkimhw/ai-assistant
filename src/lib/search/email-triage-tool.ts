import { tool } from "ai";
import { z } from "zod";
import { dateBoundary, withinBounds } from "@/lib/search/date-boundary";
import { truncateBody } from "@/lib/search/email-search-tool";
import {
  getThreadStates,
  isAutomatedSender,
  type ThreadState,
} from "@/lib/search/emails";

/**
 * The email triage tool the chat model calls. It answers the question the other
 * three cannot: which conversations are waiting on the user.
 *
 * `searchEmails` ranks by similarity to a query and `filterEmails` matches
 * literal facts on a single message. "What's urgent", "what needs a reply",
 * "what should I deal with first" reach neither, because they are questions
 * about the *state of a conversation* — who spoke last, whether anyone is
 * waiting — and no phrasing turns that into a query or a substring. Without this
 * tool a model asked one of them searches for the word "urgent", finds the
 * emails that say it rather than the ones that mean it, and rephrases until the
 * step ceiling stops it. That turn is what this exists to prevent; see issue #15.
 *
 * The line it holds is between facts and judgement. This returns a candidate set
 * with state attached — who wrote last, how long ago, whether they asked
 * anything — and stops there. Which of those actually matters is the model's
 * job, done by reading them. A parameter like `urgentOnly` would be the tool
 * claiming to know something it cannot see, and the count it returned would be a
 * lie of exactly the kind `totalMatches` exists to prevent elsewhere.
 *
 * Two things live here and nowhere else — the Zod input schema and the
 * model-facing description text.
 *
 * Server-only: reads `data/emails.json` from disk. Do not import from a client
 * component.
 */

/**
 * Fixed, not a tool parameter, for the same reason the other two tools' counts
 * are: a number the model can choose is a decision it has to make every call.
 *
 * Fifteen against roughly a hundred candidates. Triage is a reading task, and
 * the answer the user wants is three or four threads with reasons — a model
 * given fifty rows starts summarising the list instead of judging it. Fifteen is
 * enough that the right answer is very likely present and few enough that each
 * row gets read. `totalMatches` keeps the slice honest.
 */
export const EMAIL_TRIAGE_RESULT_COUNT = 15;

/** Written for the model, not for a reader of this file. */
export const EMAIL_TRIAGE_TOOL_DESCRIPTION =
  "Review the state of the user's conversations: which threads are waiting on a " +
  "reply from them, and how long they have been waiting. Use this for any " +
  "question with no search terms in it — 'what's urgent', 'what needs a reply', " +
  "'what should I deal with first', 'what am I behind on'. Searching for words " +
  "like 'urgent' or 'ASAP' will NOT answer those: urgency is not a word in an " +
  "email, it is the state of a conversation, and this is the only tool that can " +
  "see that state. Takes no query, and for those questions a call with no " +
  "arguments at all is the right one. Set `awaiting: \"them\"` instead — and " +
  "only then — for the mirror question, 'what am I waiting on' or 'who owes me " +
  "a reply'. Returns threads newest first, at " +
  `most ${EMAIL_TRIAGE_RESULT_COUNT} of them alongside the true total — each ` +
  "with the last message, who sent it, how many days it has sat, and whether it " +
  "asks a question. Those are facts, not a ranking: decide what is actually " +
  "urgent yourself by reading them, and say why each one matters rather than " +
  "listing them back. `waitingDays` is time since the last message, not a " +
  "deadline. Bodies are truncated — call getEmails with `lastMessageId` and " +
  "`expandThread: true` to read a thread before quoting it.";

export const emailTriageInputSchema = z.object({
  awaiting: z
    .enum(["you", "them"])
    .describe(
      "Whose turn it is. \"you\" (the default) gives threads where someone " +
        "wrote to the user and the user has not replied since — for 'what needs " +
        "a reply'. \"them\" gives threads where the user wrote last and is " +
        "waiting on an answer — for 'what am I waiting on' and 'who owes me a " +
        "reply'."
    )
    .optional(),
  includeAutomated: z
    .boolean()
    .describe(
      "Include threads whose last message came from a no-reply or automated " +
        "sender. Off by default: receipts, notifications and newsletters are " +
        "the majority of unanswered mail and none of it needs a reply. Turn it " +
        "on only when the user is asking about notifications themselves."
    )
    .optional(),
  after: dateBoundary({
    description:
      "Only threads whose last message is at or after this point. " +
      "`YYYY-MM-DD` means the start of that day; an ISO-8601 datetime is used " +
      "as given, and counts as UTC unless it carries a timezone. Inclusive. " +
      "Leave both dates off to see the whole inbox, which is usually right.",
  }),
  before: dateBoundary({
    description:
      "Only threads whose last message is at or before this point. " +
      "`YYYY-MM-DD` means the END of that day. A datetime counts as UTC unless " +
      "it carries a timezone. Inclusive.",
  }),
});

export type EmailTriageInput = z.infer<typeof emailTriageInputSchema>;

/**
 * A thread as the model reads it. Every field is an observation, and the names
 * say so — `lastMessageAsksQuestion`, not `needsReply`. The moment one of these
 * starts asserting a conclusion, the model stops doing the judging and starts
 * trusting a heuristic that cannot see what it can.
 *
 * `lastMessageId` is a real email id: it is what makes this compose with
 * `getEmails` rather than being a fourth way to search.
 */
export type TriageThread = {
  threadId: string;
  subject: string;
  messageCount: number;
  lastMessageId: string;
  lastMessageFrom: string;
  lastMessageAt: string;
  lastMessageBody: string;
  waitingDays: number;
  lastSenderIsAutomated: boolean;
  lastMessageAsksQuestion: boolean;
};

/**
 * `totalMatches` counts before the cap, matching `filterEmails`. "You have 43
 * threads waiting and here are the 15 newest" is a different and more honest
 * sentence than one assembled from the length of a truncated list.
 */
export type EmailTriageOutput = {
  totalMatches: number;
  threads: TriageThread[];
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days since the last message, floored. Never negative, because a thread
 * whose last message has not arrived yet is not in the candidate set at all —
 * see `hasArrived` below.
 */
const waitingDaysSince = (opts: { timestamp: string; now: number }) =>
  Math.floor((opts.now - Date.parse(opts.timestamp)) / MS_PER_DAY);

/**
 * A message dated in the future is not waiting on a reply. Nothing can be, until
 * it arrives.
 *
 * This is not a hypothetical: 36 emails in the committed corpus are timestamped
 * after today, 8 of them the last message of a thread awaiting the user. Without
 * this test they take eight of the fifteen slots — the newest-first sort puts
 * them at the very top — and every one reports `waitingDays: 0`, which reads as
 * "arrived today" and is indistinguishable from genuinely fresh mail. Over half
 * the cap, spent on mail that has not been sent, crowding out threads that have
 * genuinely sat for a month.
 *
 * Clamping the number at zero, which is what this replaced, fixed how the field
 * *displayed* and left the ranking untouched. The ranking was the real damage.
 *
 * The cost is bounded and self-correcting: a sender whose clock runs fast drops
 * out of triage until their timestamp passes, and reappears on its own. Search,
 * filter and fetch are unaffected — the email is in the corpus, it is simply not
 * yet something anyone is waiting on.
 */
const hasArrived = (opts: { timestamp: string; now: number }) =>
  Date.parse(opts.timestamp) <= opts.now;

const toTriageThread = (opts: { state: ThreadState; now: number }): TriageThread => {
  const { lastMessage } = opts.state;

  return {
    threadId: opts.state.threadId,
    subject: lastMessage.subject,
    messageCount: opts.state.messageCount,
    lastMessageId: lastMessage.id,
    lastMessageFrom: lastMessage.from,
    lastMessageAt: lastMessage.timestamp,
    // The same budget as a search or filter result, by taking the same default.
    lastMessageBody: truncateBody(lastMessage.body),
    waitingDays: waitingDaysSince({
      timestamp: lastMessage.timestamp,
      now: opts.now,
    }),
    lastSenderIsAutomated: isAutomatedSender(lastMessage.from),
    // Crude, and labelled as such: a question mark anywhere in the body. It
    // fires on 61 of the 100 human threads awaiting the user, which is a useful
    // spread rather than a verdict — plenty of messages need an answer without
    // asking for one, and plenty of rhetorical questions need nothing.
    lastMessageAsksQuestion: lastMessage.body.includes("?"),
  };
};

/**
 * The clock is a parameter for the same reason every other collaborator in
 * `search/` is one: `waitingDays` is the single field here that depends on
 * something outside the corpus, and a test that read the real clock would drift
 * a day at a time. Defaults to the real one.
 */
export const createEmailTriageTool = (opts?: { now?: () => number }) =>
  tool({
    description: EMAIL_TRIAGE_TOOL_DESCRIPTION,
    inputSchema: emailTriageInputSchema,
    execute: async (input): Promise<EmailTriageOutput> => {
      const now = opts?.now?.() ?? Date.now();
      const awaiting = input.awaiting ?? "you";

      const matched = getThreadStates().filter((state) => {
        if (state.awaiting !== awaiting) return false;

        if (!hasArrived({ timestamp: state.lastMessage.timestamp, now }))
          return false;

        // Tested on the *last* sender, which is the one whose message is
        // sitting there. On an `awaiting: "them"` thread that is the user, who
        // is never automated, so this cannot narrow that direction.
        if (!input.includeAutomated && isAutomatedSender(state.lastMessage.from))
          return false;

        return withinBounds({
          timestamp: state.lastMessage.timestamp,
          after: input.after,
          before: input.before,
        });
      });

      // Newest first, and this is the load-bearing choice in the module.
      //
      // Longest-waiting-first is the intuitive order for triage and is wrong
      // here: this corpus spans two and a half years, so the fifteen stalest
      // threads are all from 2024 and every one of them is abandoned rather than
      // urgent. The cap decides what the model can see at all, and recency is a
      // far better prior for "needs answering now". Staleness is not lost — it
      // is on every row as `waitingDays`, for the model to weigh.
      //
      // Because this order is what the cap acts on, anything that sorts to the
      // top and does not belong there costs a slot outright. That is why
      // `hasArrived` is a filter and not a display fix.
      matched.sort((a, b) =>
        b.lastMessage.timestamp.localeCompare(a.lastMessage.timestamp)
      );

      return {
        totalMatches: matched.length,
        threads: matched
          .slice(0, EMAIL_TRIAGE_RESULT_COUNT)
          .map((state) => toTriageThread({ state, now })),
      };
    },
  });

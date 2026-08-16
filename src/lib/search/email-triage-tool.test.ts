import { describe, expect, it } from "vitest";
import { EMAIL_SEARCH_BODY_CHARACTERS } from "@/lib/search/email-search-tool";
import {
  createEmailTriageTool,
  EMAIL_TRIAGE_RESULT_COUNT,
  emailTriageInputSchema,
  type EmailTriageInput,
  type EmailTriageOutput,
} from "@/lib/search/email-triage-tool";
import { getEmailById } from "@/lib/search/emails";

/**
 * The tool is exercised at its own seam: build it and call `execute`. No
 * embedder, no ranker, no network — triage is a predicate over thread state.
 *
 * The clock is injected rather than mocked, for the reason the suite injects
 * every other collaborator: `waitingDays` is the one field here derived from
 * something outside the corpus, and a test that read the real clock would drift
 * a day at a time until it failed for no reason anyone could reconstruct.
 *
 * Counts below are facts about the committed corpus, stated once:
 *
 *   295 threads over 547 emails
 *   258 awaiting the user — 100 of them from a human, 158 from an automated sender
 *    37 awaiting the other party
 *    19 human, awaiting the user, last written to in the first half of 2026
 *   the newest such thread was last written to 2026-10-25T22:54Z
 */

const CORPUS_THREADS = 295;
const AWAITING_USER = 258;
const AWAITING_USER_HUMAN = 100;
const AWAITING_THEM = 37;

/** After every timestamp in the corpus, so every thread counts as arrived. */
const AFTER_THE_CORPUS = "2026-10-30T22:54:00.000Z";

const triage = async (
  input: EmailTriageInput,
  opts?: { now?: string }
): Promise<EmailTriageOutput> => {
  const tool = createEmailTriageTool({
    now: () => Date.parse(opts?.now ?? AFTER_THE_CORPUS),
  });

  if (!tool.execute) throw new Error("the tool must be executable");

  return (await tool.execute(input, {
    toolCallId: "test-call",
    messages: [],
  })) as EmailTriageOutput;
};

describe("createEmailTriageTool", () => {
  describe("whose turn it is", () => {
    it("defaults to the threads awaiting the user", async () => {
      const { threads } = await triage({});

      expect(threads.length).toBeGreaterThan(0);
      for (const thread of threads) {
        expect(thread.lastMessageFrom).not.toBe("sarah.chen.personal@gmail.com");
      }
    });

    it("drops automated senders by default", async () => {
      const { totalMatches } = await triage({});

      expect(totalMatches).toBe(AWAITING_USER_HUMAN);
    });

    it("keeps them when asked", async () => {
      const { totalMatches } = await triage({ includeAutomated: true });

      expect(totalMatches).toBe(AWAITING_USER);
    });

    it("finds the threads the user is waiting on", async () => {
      const { totalMatches, threads } = await triage({ awaiting: "them" });

      expect(totalMatches).toBe(AWAITING_THEM);
      for (const thread of threads) {
        expect(thread.lastMessageFrom).toBe("sarah.chen.personal@gmail.com");
      }
    });

    /**
     * The automated filter tests the *last* sender, and on these threads that is
     * the user. Nothing to exclude, so the flag cannot move the count — pinned
     * because a filter written against the wrong end of the thread would look
     * correct everywhere else.
     */
    it("is unmoved by includeAutomated when the user spoke last", async () => {
      const without = await triage({ awaiting: "them" });
      const with_ = await triage({ awaiting: "them", includeAutomated: true });

      expect(with_.totalMatches).toBe(without.totalMatches);
    });

    it("covers every thread between the two directions", async () => {
      const you = await triage({ includeAutomated: true });
      const them = await triage({ awaiting: "them" });

      expect(you.totalMatches + them.totalMatches).toBe(CORPUS_THREADS);
    });
  });

  describe("the window", () => {
    it("narrows to threads whose last message falls inside it", async () => {
      const { totalMatches } = await triage({
        after: "2026-01-01",
        before: "2026-06-30",
      });

      expect(totalMatches).toBe(19);
    });

    it("returns nothing for a window before the corpus", async () => {
      const { totalMatches, threads } = await triage({ before: "2020-01-01" });

      expect(totalMatches).toBe(0);
      expect(threads).toEqual([]);
    });
  });

  describe("how long it has been waiting", () => {
    it("counts whole days since the last message", async () => {
      // The corpus's newest human thread awaiting the user was last written to
      // 2026-10-25T22:54Z. Five days before the injected clock, to the minute.
      const { threads } = await triage({}, { now: "2026-10-30T22:54:00.000Z" });

      expect(threads[0].lastMessageAt).toBe("2026-10-25T22:54:00.000Z");
      expect(threads[0].waitingDays).toBe(5);
    });

    /**
     * The corpus dates 36 emails after today, 8 of them the last message of a
     * thread awaiting the user. Left in, they take the top 8 of the 15 slots —
     * newest-first puts them there — and each reports 0 days, indistinguishable
     * from mail that genuinely arrived today. This is the ranking test, not a
     * display one: what it pins is that the cap is spent on real threads.
     */
    it("omits a thread whose last message has not arrived yet", async () => {
      const now = "2026-08-16T00:00:00.000Z";
      const { totalMatches, threads } = await triage({}, { now });

      for (const thread of threads) {
        expect(thread.lastMessageAt <= now).toBe(true);
        expect(thread.waitingDays).toBeGreaterThanOrEqual(0);
      }

      // 100 threads awaiting a human reply, 8 of them not yet sent.
      expect(totalMatches).toBe(92);
    });

    it("counts a thread that has only just arrived as zero days", async () => {
      // The newest arrived message at this instant landed 23 minutes earlier.
      const { threads } = await triage({}, { now: "2026-08-14T20:00:00.000Z" });

      expect(threads[0].lastMessageAt).toBe("2026-08-14T19:37:00.000Z");
      expect(threads[0].waitingDays).toBe(0);
    });
  });

  describe("the payload", () => {
    it("orders threads by their last message, newest first", async () => {
      const { threads } = await triage({});

      const timestamps = threads.map((thread) => thread.lastMessageAt);
      expect(timestamps).toEqual([...timestamps].sort().reverse());
    });

    it("reports the total from before the cap, and caps the threads", async () => {
      const { totalMatches, threads } = await triage({});

      expect(totalMatches).toBe(AWAITING_USER_HUMAN);
      expect(threads).toHaveLength(EMAIL_TRIAGE_RESULT_COUNT);
    });

    it("hands back an id that getEmails can actually fetch", async () => {
      const { threads } = await triage({});

      for (const thread of threads) {
        expect(getEmailById(thread.lastMessageId)?.threadId).toBe(
          thread.threadId
        );
      }
    });

    it("truncates bodies to the shared budget", async () => {
      const { threads } = await triage({ includeAutomated: true });

      for (const thread of threads) {
        expect(thread.lastMessageBody.length).toBeLessThanOrEqual(
          EMAIL_SEARCH_BODY_CHARACTERS
        );
      }
    });

    it("counts every message in the thread, not just the unanswered one", async () => {
      const { threads } = await triage({});

      expect(threads.some((thread) => thread.messageCount > 1)).toBe(true);
      for (const thread of threads) {
        expect(thread.messageCount).toBeGreaterThan(0);
      }
    });

    /**
     * The corpus's newest waiting thread ends "I'll draft something up and send
     * you the final version" — no question, and nothing needing a reply. It is
     * the case that shows why this field is named for what it observes rather
     * than for what it implies: the model has to read the row and decide.
     */
    it("reports whether the last message asks anything, without judging it", async () => {
      const { threads } = await triage({});

      const closing = threads.find(
        (thread) => thread.lastMessageId === "email_1759406410113_ksiy06j3j"
      );
      const asking = threads.find(
        (thread) => thread.lastMessageId === "email_1759406383552_wt1bp6vjc"
      );

      expect(closing?.lastMessageAsksQuestion).toBe(false);
      expect(asking?.lastMessageAsksQuestion).toBe(true);
    });

    it("carries exactly the documented fields", async () => {
      const [thread] = (await triage({})).threads;

      expect(Object.keys(thread).sort()).toEqual([
        "lastMessageAsksQuestion",
        "lastMessageAt",
        "lastMessageBody",
        "lastMessageFrom",
        "lastMessageId",
        "lastSenderIsAutomated",
        "messageCount",
        "subject",
        "threadId",
        "waitingDays",
      ]);
    });
  });
});

describe("emailTriageInputSchema", () => {
  const accepts = (input: unknown) =>
    emailTriageInputSchema.safeParse(input).success;

  /**
   * The opposite of `filterEmails`, deliberately. There the empty call is an
   * error because "every email" is not a request; here it is the commonest call
   * there is — "what needs me" takes no arguments — so there is no rule for the
   * model to discover by failing.
   */
  it("accepts a call with no arguments at all", () => {
    expect(accepts({})).toBe(true);
  });

  it("accepts each argument on its own", () => {
    expect(accepts({ awaiting: "you" })).toBe(true);
    expect(accepts({ awaiting: "them" })).toBe(true);
    expect(accepts({ includeAutomated: true })).toBe(true);
    expect(accepts({ after: "2026-01-01" })).toBe(true);
    expect(accepts({ before: "2026-01-01T09:00:00Z" })).toBe(true);
  });

  it("rejects a direction that is neither", () => {
    expect(accepts({ awaiting: "everyone" })).toBe(false);
  });

  it("rejects an unparseable date, the same way filterEmails does", () => {
    expect(accepts({ after: "last tuesday" })).toBe(false);
    expect(accepts({ before: "2024-13-45" })).toBe(false);
  });
});

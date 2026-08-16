import { describe, expect, it } from "vitest";
import {
  createEmailFilterTool,
  EMAIL_FILTER_RESULT_COUNT,
  emailFilterInputSchema,
  type EmailFilterOutput,
} from "@/lib/search/email-filter-tool";
import { EMAIL_SEARCH_BODY_CHARACTERS } from "@/lib/search/email-search-tool";

/**
 * The tool is exercised at its own seam: build it and call `execute` with typed
 * arguments. No embedder, no ranker, no network — filtering is a predicate.
 *
 * Assertions here are **exact**, unlike the loose ones in
 * `email-search-tool.test.ts`, and the difference is the same one the suite
 * already draws between `bm25.test.ts` and `rrf.test.ts`: relevance is a knob
 * expected to move, so it is asserted relationally; a filter has one right
 * answer, so there is no reason to settle for less than the number.
 *
 * The counts below are facts about the committed corpus, stated once here:
 *
 *   547 emails, 2024-06-01T09:03Z … 2026-10-25T22:54Z
 *     5 sent from `david.xu@firsthomemortgages.co.uk`, the only sender at that domain
 *     3 sent on 2024-06-01, the corpus's earliest day
 *     3 addressed to more than one recipient
 *     8 containing "invoice", 1 containing "deansgate"
 *   140 sent from `sarah.chen.personal@gmail.com`, comfortably over the cap
 */

const CORPUS_SIZE = 547;

const filter = async (criteria: {
  from?: string;
  to?: string;
  after?: string;
  before?: string;
  contains?: string;
}): Promise<EmailFilterOutput> => {
  const tool = createEmailFilterTool();

  if (!tool.execute) throw new Error("the tool must be executable");

  return (await tool.execute(criteria, {
    toolCallId: "test-call",
    messages: [],
  })) as EmailFilterOutput;
};

const accepts = (criteria: unknown) =>
  emailFilterInputSchema.safeParse(criteria).success;

describe("createEmailFilterTool", () => {
  describe("sender", () => {
    it("matches a sender on a partial string", async () => {
      const { totalMatches } = await filter({ from: "david.xu" });

      expect(totalMatches).toBe(5);
    });

    it("matches a sender case-insensitively", async () => {
      const lower = await filter({ from: "david.xu" });
      const upper = await filter({ from: "DAVID.XU" });

      expect(upper.totalMatches).toBe(lower.totalMatches);
      expect(upper.emails.map((email) => email.id)).toEqual(
        lower.emails.map((email) => email.id)
      );
    });

    it("matches every sender at a domain from a domain fragment", async () => {
      const { totalMatches, emails } = await filter({
        from: "firsthomemortgages",
      });

      expect(totalMatches).toBe(5);
      expect(
        emails.every((email) => email.from.includes("firsthomemortgages"))
      ).toBe(true);
    });
  });

  describe("recipient", () => {
    it("matches a recipient", async () => {
      const { emails } = await filter({ to: "sarah.chen.personal" });

      expect(emails.length).toBeGreaterThan(0);
      expect(
        emails.every((email) => email.to.includes("sarah.chen.personal"))
      ).toBe(true);
    });

    it("matches an email addressed to several people by any one of them", async () => {
      // `email_1759405356237_g11lxjh9a` is addressed to sophie, mike, and jp.
      const { emails } = await filter({ to: "mikethompson84" });

      expect(emails.map((email) => email.id)).toContain(
        "email_1759405356237_g11lxjh9a"
      );
    });
  });

  describe("dates", () => {
    it("matches emails on or after a date", async () => {
      const { totalMatches } = await filter({ after: "2024-06-02" });

      // Everything but the three on the corpus's first day.
      expect(totalMatches).toBe(CORPUS_SIZE - 3);
    });

    it("matches emails on or before a date", async () => {
      const { totalMatches } = await filter({ before: "2024-06-01" });

      expect(totalMatches).toBe(3);
    });

    it("matches a range when both ends are given", async () => {
      const { totalMatches } = await filter({
        after: "2024-06-01",
        before: "2024-06-01",
      });

      expect(totalMatches).toBe(3);
    });

    it("includes an email sitting exactly on a bare-date boundary", async () => {
      // The three emails on 2024-06-01 run 09:03 to 15:59. A bare date means the
      // whole day at both ends, so all three survive both boundaries.
      const after = await filter({ after: "2024-06-01" });
      const before = await filter({ before: "2024-06-01" });

      expect(after.totalMatches).toBe(CORPUS_SIZE);
      expect(before.totalMatches).toBe(3);
    });

    it("uses a datetime exactly as given", async () => {
      const { totalMatches } = await filter({
        after: "2024-06-01T13:00:00.000Z",
        before: "2024-06-01T16:00:00.000Z",
      });

      // 09:03 falls outside; 13:29 and 15:59 do not.
      expect(totalMatches).toBe(2);
    });

    it("reads a datetime with no timezone as UTC", async () => {
      // The form a model reaches for most readily. JavaScript would read it as
      // local time, putting it hours away from the same instant written as a
      // bare date — so the two must agree here or the difference is a silent
      // off-by-a-timezone in every answer.
      const zoned = await filter({
        after: "2024-06-01T13:00:00.000Z",
        before: "2024-06-01T16:00:00.000Z",
      });
      const bare = await filter({
        after: "2024-06-01T13:00:00",
        before: "2024-06-01T16:00:00",
      });

      expect(bare.totalMatches).toBe(zoned.totalMatches);
      expect(bare.emails.map((email) => email.id)).toEqual(
        zoned.emails.map((email) => email.id)
      );
    });

    it("accepts a datetime without seconds", async () => {
      const { totalMatches } = await filter({ after: "2024-06-01T13:00" });

      expect(totalMatches).toBe(CORPUS_SIZE - 1);
    });

    it("returns nothing for a range that precedes the corpus", async () => {
      const { totalMatches, emails } = await filter({ before: "2020-01-01" });

      expect(totalMatches).toBe(0);
      expect(emails).toEqual([]);
    });
  });

  describe("contained text", () => {
    it("matches text in the subject or the body", async () => {
      const { totalMatches } = await filter({ contains: "invoice" });

      expect(totalMatches).toBe(8);
    });

    it("shows the match even when it sits past the truncation budget", async () => {
      // `contains` tests the whole body while the payload carries a truncated
      // one, so without a window a match this deep comes back invisible — an
      // email that provably does not contain what it was filtered on.
      const { emails } = await filter({ contains: "allergen" });

      expect(emails.length).toBeGreaterThan(0);
      for (const email of emails) {
        expect(email.body.toLowerCase()).toContain("allergen");
        expect(email.body.length).toBeLessThanOrEqual(
          EMAIL_SEARCH_BODY_CHARACTERS
        );
      }
    });

    it("opens with an ellipsis when the window has slid off the start", async () => {
      const { emails } = await filter({ contains: "allergen" });

      expect(emails.some((email) => email.body.startsWith("…"))).toBe(true);
    });

    it("leaves an early match truncated the ordinary way", async () => {
      const { emails } = await filter({ contains: "deansgate" });

      expect(emails[0].body.startsWith("…")).toBe(false);
    });

    it("matches contained text case-insensitively", async () => {
      const lower = await filter({ contains: "deansgate" });
      const upper = await filter({ contains: "Deansgate" });

      expect(lower.totalMatches).toBe(1);
      expect(upper.totalMatches).toBe(1);
    });
  });

  describe("combining criteria", () => {
    it("narrows rather than widens", async () => {
      const from = await filter({ from: "david.xu" });
      const both = await filter({ from: "david.xu", before: "2024-06-01" });

      expect(from.totalMatches).toBe(5);
      expect(both.totalMatches).toBe(2);
    });

    it("keeps a match that satisfies every criterion", async () => {
      // The corpus's one "deansgate" email is from david.xu, so this pair holds
      // together and the next test's pair cannot.
      const { totalMatches } = await filter({
        from: "david.xu",
        contains: "deansgate",
      });

      expect(totalMatches).toBe(1);
    });

    it("returns nothing when the criteria cannot both hold", async () => {
      const { totalMatches, emails } = await filter({
        from: "noreply@spotify.com",
        contains: "deansgate",
      });

      expect(totalMatches).toBe(0);
      expect(emails).toEqual([]);
    });
  });

  describe("the payload", () => {
    it("orders matches newest first", async () => {
      const { emails } = await filter({ from: "david.xu" });

      const timestamps = emails.map((email) => email.timestamp);
      expect(timestamps).toEqual([...timestamps].sort().reverse());
    });

    it("reports the total from before the cap, and caps the emails", async () => {
      const { totalMatches, emails } = await filter({ from: "sarah.chen" });

      expect(totalMatches).toBe(140);
      expect(emails).toHaveLength(EMAIL_FILTER_RESULT_COUNT);
    });

    it("returns every match when there are fewer than the cap", async () => {
      const { totalMatches, emails } = await filter({ from: "david.xu" });

      expect(totalMatches).toBe(5);
      expect(emails).toHaveLength(5);
    });

    it("truncates bodies to the shared budget", async () => {
      const { emails } = await filter({ contains: "invoice" });

      for (const email of emails) {
        expect(email.body.length).toBeLessThanOrEqual(
          EMAIL_SEARCH_BODY_CHARACTERS
        );
      }
    });

    it("carries exactly the documented fields, and no score", async () => {
      const [email] = (await filter({ from: "david.xu" })).emails;

      expect(Object.keys(email).sort()).toEqual([
        "body",
        "from",
        "id",
        "subject",
        "timestamp",
        "to",
      ]);
    });
  });
});

describe("emailFilterInputSchema", () => {
  it("accepts each criterion on its own", () => {
    expect(accepts({ from: "david" })).toBe(true);
    expect(accepts({ to: "sarah" })).toBe(true);
    expect(accepts({ after: "2024-06-01" })).toBe(true);
    expect(accepts({ before: "2024-06-01" })).toBe(true);
    expect(accepts({ contains: "invoice" })).toBe(true);
  });

  it("accepts a full datetime", () => {
    expect(accepts({ after: "2024-06-01T13:29:00.000Z" })).toBe(true);
  });

  it("accepts a datetime with no timezone, and one with an offset", () => {
    expect(accepts({ after: "2024-06-01T13:29:00" })).toBe(true);
    expect(accepts({ after: "2024-06-01T13:29" })).toBe(true);
    expect(accepts({ after: "2024-06-01T13:29:00+01:00" })).toBe(true);
  });

  it("rejects a call with no criteria, rather than returning the corpus", () => {
    expect(accepts({})).toBe(false);
  });

  // The rule is invisible in the JSON Schema the model is shown, so the only
  // way it learns the rule is by reading this message after failing. That makes
  // the wording load-bearing in a way a rejection message usually is not: it is
  // the difference between one wasted step and a sequence of them. Pinned on
  // content rather than on exact prose, so it can be reworded but not gutted.
  it("tells a rejected call which criteria exist and what to use instead", () => {
    const result = emailFilterInputSchema.safeParse({});
    const message = result.success
      ? ""
      : result.error.issues.map((issue) => issue.message).join(" ");

    for (const criterion of ["from", "to", "after", "before", "contains"]) {
      expect(message).toContain(criterion);
    }
    expect(message).toContain("searchEmails");
  });

  it("rejects criteria that are present but empty", () => {
    expect(accepts({ from: "" })).toBe(false);
  });

  it("rejects an unparseable date", () => {
    expect(accepts({ after: "last tuesday" })).toBe(false);
    expect(accepts({ before: "2024-13-45" })).toBe(false);
  });
});

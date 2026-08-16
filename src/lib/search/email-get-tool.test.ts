import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createEmailGetTool,
  EMAIL_GET_MAX_IDS,
  emailGetInputSchema,
  type EmailGetOutput,
} from "@/lib/search/email-get-tool";
import { EMAIL_SEARCH_BODY_CHARACTERS } from "@/lib/search/email-search-tool";
import type { Email } from "@/lib/search/emails";

/**
 * Same seam as the other two tools: build it, call `execute`, assert on what
 * comes back. Exact assertions, for the same reason as the filter tool — there
 * is one right answer to "give me this email".
 *
 * The corpus facts these lean on:
 *
 *   `email_1759404204639_oqluqiru9` is a three-message thread running
 *     09:03 → 13:29 → 15:59 on 2024-06-01
 *   `email_1759405771467_yq6r4e7q3` has the corpus's longest body, 6660
 *     characters — over five times the search tool's truncation budget, which is
 *     what makes it the right email to pin the no-truncation guarantee on
 */

const CORPUS_PATH = path.join(process.cwd(), "data", "emails.json");

const corpus = (): Email[] =>
  JSON.parse(fs.readFileSync(CORPUS_PATH, "utf-8")) as Email[];

const THREAD_ID = "email_1759404204639_oqluqiru9";
const THREAD_FIRST = "email_1759404204639_rcsddgue6";
const THREAD_SECOND = "email_1759404204640_3w6dgvlnl";
const THREAD_THIRD = "email_1759404204640_n3d5zcqcg";
const LONGEST_BODY = "email_1759405771467_yq6r4e7q3";

/**
 * Two three-message threads that overlap in time: the second starts on
 * 2024-08-24T14:49Z, four and a half hours before the first ends. Ordering by
 * timestamp across both would interleave them.
 */
const OVERLAPPING_A_THREAD = "email_1759404481837_x1e2ea434";
const OVERLAPPING_A = "email_1759404481837_ufvmnn0h6";
const OVERLAPPING_B_THREAD = "email_1759404496145_z4vw2o3r0";
const OVERLAPPING_B = "email_1759404496145_wj8oa82zs";

const get = async (input: {
  ids: string[];
  expandThread?: boolean;
}): Promise<EmailGetOutput> => {
  const tool = createEmailGetTool();

  if (!tool.execute) throw new Error("the tool must be executable");

  return (await tool.execute(input, {
    toolCallId: "test-call",
    messages: [],
  })) as EmailGetOutput;
};

const ids = (output: EmailGetOutput) => output.emails.map((email) => email.id);

describe("createEmailGetTool", () => {
  describe("fetching by id", () => {
    it("returns the email named by an id", async () => {
      const { emails, missingIds } = await get({ ids: [THREAD_FIRST] });

      expect(emails).toHaveLength(1);
      expect(emails[0].id).toBe(THREAD_FIRST);
      expect(missingIds).toEqual([]);
    });

    it("returns several emails at once", async () => {
      const output = await get({ ids: [THREAD_FIRST, LONGEST_BODY] });

      expect(ids(output).sort()).toEqual([LONGEST_BODY, THREAD_FIRST].sort());
    });

    it("returns each email once even if an id is repeated", async () => {
      const output = await get({ ids: [THREAD_FIRST, THREAD_FIRST] });

      expect(ids(output)).toEqual([THREAD_FIRST]);
    });
  });

  describe("the no-truncation guarantee", () => {
    it("returns a long body in full, byte for byte", async () => {
      const expected = corpus().find((email) => email.id === LONGEST_BODY);
      if (!expected) throw new Error("the corpus no longer holds that email");

      const { emails } = await get({ ids: [LONGEST_BODY] });

      expect(emails[0].body).toBe(expected.body);
      // …and this asserts something only because the body is over the budget
      // the search and filter tools cut at.
      expect(expected.body.length).toBeGreaterThan(EMAIL_SEARCH_BODY_CHARACTERS);
    });
  });

  describe("unknown ids", () => {
    it("reports an unknown id rather than dropping it", async () => {
      const { emails, missingIds } = await get({
        ids: [THREAD_FIRST, "email_nope"],
      });

      expect(ids({ emails, missingIds })).toEqual([THREAD_FIRST]);
      expect(missingIds).toEqual(["email_nope"]);
    });

    it("reports a repeated unknown id once, as it does a repeated known one", async () => {
      const { missingIds } = await get({ ids: ["email_nope", "email_nope"] });

      expect(missingIds).toEqual(["email_nope"]);
    });

    it("returns no emails and every id when none are known", async () => {
      const { emails, missingIds } = await get({ ids: ["nope_1", "nope_2"] });

      expect(emails).toEqual([]);
      expect(missingIds).toEqual(["nope_1", "nope_2"]);
    });
  });

  describe("expandThread", () => {
    it("pulls in the siblings of a multi-message thread", async () => {
      const output = await get({ ids: [THREAD_SECOND], expandThread: true });

      expect(ids(output)).toEqual([THREAD_FIRST, THREAD_SECOND, THREAD_THIRD]);
    });

    it("orders an expanded thread oldest first", async () => {
      const { emails } = await get({ ids: [THREAD_THIRD], expandThread: true });

      const timestamps = emails.map((email) => email.timestamp);
      expect(timestamps).toEqual([...timestamps].sort());
    });

    it("returns a thread once when several of its members are asked for", async () => {
      const output = await get({
        ids: [THREAD_FIRST, THREAD_THIRD],
        expandThread: true,
      });

      expect(ids(output)).toEqual([THREAD_FIRST, THREAD_SECOND, THREAD_THIRD]);
    });

    it("returns just the email when its thread holds nothing else", async () => {
      const emails = corpus();
      const threadSizes = new Map<string, number>();
      for (const email of emails) {
        threadSizes.set(
          email.threadId,
          (threadSizes.get(email.threadId) ?? 0) + 1
        );
      }

      const solitary = emails.find(
        (email) => threadSizes.get(email.threadId) === 1
      );
      if (!solitary) throw new Error("the corpus no longer holds a lone email");

      const output = await get({ ids: [solitary.id], expandThread: true });

      expect(ids(output)).toEqual([solitary.id]);
    });

    it("leaves siblings out when it is not asked for", async () => {
      const output = await get({ ids: [THREAD_SECOND] });

      expect(ids(output)).toEqual([THREAD_SECOND]);
    });

    it("keeps two expanded threads apart rather than interleaving them", async () => {
      // These two threads genuinely overlap in time — the second starts four
      // hours before the first ends — so sorting every email by timestamp alone
      // would deal the conversations together like a shuffled deck. Each thread
      // arrives whole, in the order its members were first asked for.
      const { emails } = await get({
        ids: [OVERLAPPING_A, OVERLAPPING_B],
        expandThread: true,
      });

      expect(emails.map((email) => email.threadId)).toEqual([
        ...Array(3).fill(OVERLAPPING_A_THREAD),
        ...Array(3).fill(OVERLAPPING_B_THREAD),
      ]);
    });

    it("still reports an unknown id when expanding", async () => {
      const { missingIds } = await get({
        ids: [THREAD_FIRST, "email_nope"],
        expandThread: true,
      });

      expect(missingIds).toEqual(["email_nope"]);
    });
  });

  describe("the payload", () => {
    it("carries exactly the documented fields, and no score", async () => {
      const { emails } = await get({ ids: [THREAD_FIRST] });

      expect(Object.keys(emails[0]).sort()).toEqual([
        "body",
        "from",
        "id",
        "subject",
        "threadId",
        "timestamp",
        "to",
      ]);
    });

    it("carries the thread id, so a reply can be recognised as part of one", async () => {
      const { emails } = await get({ ids: [THREAD_SECOND] });

      expect(emails[0].threadId).toBe(THREAD_ID);
    });
  });
});

describe("emailGetInputSchema", () => {
  const accepts = (input: unknown) =>
    emailGetInputSchema.safeParse(input).success;

  it("accepts a single id", () => {
    expect(accepts({ ids: [THREAD_FIRST] })).toBe(true);
  });

  it("accepts the thread flag", () => {
    expect(accepts({ ids: [THREAD_FIRST], expandThread: true })).toBe(true);
  });

  it("rejects an empty id list", () => {
    expect(accepts({ ids: [] })).toBe(false);
  });

  it("rejects an empty id", () => {
    expect(accepts({ ids: [""] })).toBe(false);
  });

  it("rejects more ids than the cap, rather than truncating silently", () => {
    const tooMany = Array.from(
      { length: EMAIL_GET_MAX_IDS + 1 },
      (_unused, index) => `email_${index}`
    );

    expect(accepts({ ids: tooMany })).toBe(false);
    expect(accepts({ ids: tooMany.slice(0, EMAIL_GET_MAX_IDS) })).toBe(true);
  });
});

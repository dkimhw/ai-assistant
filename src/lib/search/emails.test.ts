import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Embedder } from "@/lib/search/embedder";
import {
  getAllEmails,
  getThreadStates,
  INBOX_OWNER,
  isAutomatedSender,
  searchEmails,
} from "@/lib/search/emails";
import {
  decodeVectors,
  type VectorArtifact,
} from "@/lib/search/vector-artifact";

/**
 * Smoke tests, not a relevance benchmark — asserted loosely on purpose.
 *
 * The embedder is injected rather than mocked. It serves real, committed
 * embeddings of a fixed set of query strings (`data/query-vectors.json`, built
 * by `pnpm run build:vectors` alongside the corpus vectors), so these run with
 * no network and no API key while still exercising genuine semantic
 * neighbourhoods rather than made-up ones.
 */

const QUERY_VECTORS_PATH = path.join(
  process.cwd(),
  "data",
  "query-vectors.json"
);

const fixtureEmbedder = (): Embedder => {
  const artifact = JSON.parse(
    fs.readFileSync(QUERY_VECTORS_PATH, "utf-8")
  ) as VectorArtifact;

  const vectors = decodeVectors({
    vectors: artifact.vectors,
    dimensions: artifact.dimensions,
  });
  const byText = new Map(artifact.ids.map((id, index) => [id, vectors[index]]));

  return {
    model: artifact.model,
    dimensions: artifact.dimensions,
    embed: async ({ texts }) =>
      texts.map((text) => {
        const vector = byText.get(text);
        if (!vector) {
          throw new Error(
            `No committed vector for "${text}". Add it to TEST_QUERIES in scripts/build-email-vectors.ts and re-run \`pnpm run build:vectors\`.`
          );
        }
        return vector;
      }),
  };
};

const subjects = (results: Array<{ email: { subject: string } }>) =>
  results.map((result) => result.email.subject);

/**
 * The eight automated senders in the committed corpus, established by reading
 * all 56 distinct senders rather than by running the predicate and writing down
 * what it said. That is the whole value of this list: it is an independent
 * oracle, so a change to the pattern that starts catching people disagrees with
 * it instead of quietly redefining the right answer.
 */
const AUTOMATED_SENDERS = [
  "alerts@skyscanner.net",
  "auto-confirm@amazon.co.uk",
  "newsletters@theguardian.com",
  "no-reply@gov.uk",
  "noreply@booking.com",
  "noreply@britishgas.co.uk",
  "noreply@lloydsbank.co.uk",
  "noreply@spotify.com",
];

describe("isAutomatedSender", () => {
  it("catches every automated sender in the corpus", () => {
    for (const address of AUTOMATED_SENDERS) {
      expect(isAutomatedSender(address)).toBe(true);
    }
  });

  it("catches no one else in the corpus", () => {
    const automated = new Set(AUTOMATED_SENDERS);
    const senders = new Set(getAllEmails().map((email) => email.from));

    const wrong = [...senders].filter(
      (address) => isAutomatedSender(address) !== automated.has(address)
    );

    expect(wrong).toEqual([]);
  });

  /**
   * The trap, and the reason this test is worth more than the two above it. A
   * role address looks automated and mostly is not: every one of these is
   * staffed by a person in this corpus, and several are asking the user a direct
   * question. A predicate that generalised from `noreply@` to "not a personal
   * address" would hide precisely the mail that most needs a reply.
   */
  it("does not treat a staffed role address as automated", () => {
    const staffed = [
      "admin@climbingworks.com",
      "bookings@adventuresouthnz.com",
      "customerservice@bhphotovideo.com",
      "events@manchesterphotosoc.org",
      "info@manchesterphotosoc.org",
      "prints@manchesterphotolab.co.uk",
      "quotes@homerunremovals.co.uk",
      "support@skyscanner.net",
      "surveys@houseinspectionsuk.co.uk",
    ];

    for (const address of staffed) {
      expect(isAutomatedSender(address)).toBe(false);
    }
  });

  it("ignores case and the domain", () => {
    expect(isAutomatedSender("NoReply@Example.com")).toBe(true);
    expect(isAutomatedSender("sarah@noreply-consulting.com")).toBe(false);
  });

  it("does not fire on a name that merely starts with one of the words", () => {
    // `alerts` is a prefix of nothing here, but `alert` must not swallow
    // `alertonogroup@…` and `auto` must not swallow `automotive@…`.
    expect(isAutomatedSender("automotive@example.com")).toBe(false);
    expect(isAutomatedSender("noreplyable@example.com")).toBe(false);
  });
});

describe("getThreadStates", () => {
  it("derives the corpus's threads once", () => {
    expect(getThreadStates()).toBe(getThreadStates());
    expect(getThreadStates()).toHaveLength(295);
  });

  it("accounts for every email exactly once", () => {
    const counted = getThreadStates().reduce(
      (total, thread) => total + thread.messageCount,
      0
    );

    expect(counted).toBe(getAllEmails().length);
  });

  it("takes the last message by time, not by corpus order", () => {
    for (const thread of getThreadStates()) {
      expect(thread.lastMessage.threadId).toBe(thread.threadId);
      expect(thread.lastMessage.timestamp).toBe(
        getAllEmails()
          .filter((email) => email.threadId === thread.threadId)
          .map((email) => email.timestamp)
          .sort()
          .at(-1)
      );
    }
  });

  it("says the user is awaited when someone else spoke last", () => {
    for (const thread of getThreadStates()) {
      expect(thread.awaiting).toBe(
        thread.lastMessage.from === INBOX_OWNER ? "them" : "you"
      );
    }
  });

  /**
   * Loose on purpose — the corpus can grow. What is pinned is the shape of the
   * problem the triage tool exists for: "unanswered" on its own selects almost
   * everything, and only stacking the automated-sender test makes it a set worth
   * showing someone.
   */
  it("leaves a set worth triaging once automated senders are dropped", () => {
    const states = getThreadStates();
    const awaitingUser = states.filter((thread) => thread.awaiting === "you");
    const human = awaitingUser.filter(
      (thread) => !isAutomatedSender(thread.lastMessage.from)
    );

    expect(awaitingUser.length / states.length).toBeGreaterThan(0.8);
    expect(human.length).toBeLessThan(awaitingUser.length / 2);
    expect(human.length).toBeGreaterThan(20);
  });
});

describe("searchEmails", () => {
  const embedder = fixtureEmbedder();

  it("reads the whole corpus once", () => {
    expect(getAllEmails()).toBe(getAllEmails());
    expect(getAllEmails().length).toBeGreaterThan(500);
  });

  it("finds the conveyancing thread from a query sharing none of its words", async () => {
    const query =
      "when do I need to hand over the remaining money before I can pick up the keys";

    const results = await searchEmails({ query, limit: 5, embedder });

    expect(
      subjects(results).some((subject) =>
        /exchange of contracts|completion/i.test(subject)
      )
    ).toBe(true);
  });

  it("answers other conceptual queries too", async () => {
    const documents = await searchEmails({
      query: "what paperwork proves how much I earn",
      limit: 5,
      embedder,
    });
    expect(
      subjects(documents).some((subject) => /document|income|payslip/i.test(subject))
    ).toBe(true);

    const venue = await searchEmails({
      query: "somewhere to hold the reception",
      limit: 5,
      embedder,
    });
    expect(subjects(venue).some((subject) => /venue/i.test(subject))).toBe(true);
  });

  it("still lands an exact email address on that person's emails", async () => {
    const results = await searchEmails({
      query: "david.xu@firsthomemortgages.co.uk",
      limit: 3,
      embedder,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].email.from).toBe("david.xu@firsthomemortgages.co.uk");
  });

  it("puts the mortgage thread in the top 3 for 'mortgage pre-approval'", async () => {
    const results = await searchEmails({
      query: "mortgage pre-approval",
      limit: 3,
      embedder,
    });

    expect(results).toHaveLength(3);
    expect(
      subjects(results).some((subject) =>
        subject.toLowerCase().includes("mortgage")
      )
    ).toBe(true);
    expect(results[0].score).toBeGreaterThanOrEqual(results[2].score);
  });

  it("does not let a block of identical emails crowd out the real ones", async () => {
    // The corpus contains 11 byte-identical "Mortgage pre-approval update"
    // notifications from a bank. Indexed one-vector-each they take every top
    // slot for this query; one vote per distinct text is what stops them.
    const results = await searchEmails({
      query: "mortgage pre-approval",
      limit: 5,
      embedder,
    });

    expect(new Set(subjects(results)).size).toBeGreaterThanOrEqual(4);
    expect(subjects(results).slice(0, 3)).toContain(
      "Your Mortgage Pre-Approval - Great News!"
    );
  });

  it("returns [] for a query that matches nothing lexically or semantically", async () => {
    expect(await searchEmails({ query: "zzzzqqqxyzzy", embedder })).toEqual([]);
  });

  it("returns [] for an empty query without embedding it", async () => {
    const exploding: Embedder = {
      model: "never-called",
      dimensions: 1536,
      embed: async () => {
        throw new Error("should not be called");
      },
    };

    expect(await searchEmails({ query: "   ", embedder: exploding })).toEqual([]);
  });

  it("falls back to lexical-only results when the embedder fails", async () => {
    const failing: Embedder = {
      model: "offline",
      dimensions: 1536,
      embed: async () => {
        throw new Error("embedding provider unavailable");
      },
    };

    const results = await searchEmails({
      query: "mortgage pre-approval",
      limit: 3,
      embedder: failing,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(
      subjects(results).some((subject) =>
        subject.toLowerCase().includes("mortgage")
      )
    ).toBe(true);
  });
});

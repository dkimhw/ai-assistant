import fs from "node:fs";
import path from "node:path";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { documentIdOfChunk } from "@/lib/search/document-id";
import { getEmailById } from "@/lib/search/emails";
import type { Embedder } from "@/lib/search/embedder";
import {
  createEmailSearchTool,
  EMAIL_SEARCH_BODY_CHARACTERS,
  EMAIL_SEARCH_HISTORY_CHARACTERS,
  EMAIL_SEARCH_HISTORY_MESSAGES,
  EMAIL_SEARCH_RESULT_COUNT,
  emailSearchInputSchema,
  type EmailSearchResult,
} from "@/lib/search/email-search-tool";
import type { RerankCandidate, Reranker } from "@/lib/search/reranker";
import {
  decodeVectors,
  type VectorArtifact,
} from "@/lib/search/vector-artifact";

/**
 * The tool is exercised at its own seam: build it with an injected embedder and
 * call `execute` with typed arguments. No live model, no `Request`, no network.
 *
 * Relevance assertions are smoke tests asserted loosely, in the same spirit as
 * `emails.test.ts` — they prove the tool is wired to the real ranker over the
 * real corpus, not that ranking is good. What is asserted *exactly* is the
 * payload contract: the result cap, the body budget, and the field set, because
 * those are bounds the route and the model depend on rather than knobs to tune.
 */

const QUERY_VECTORS_PATH = path.join(
  process.cwd(),
  "data",
  "query-vectors.json"
);

/**
 * Serves real, committed embeddings for a fixed set of query strings
 * (`data/query-vectors.json`), so these run offline while still exercising
 * genuine semantic neighbourhoods.
 */
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

/** Stands in for an embedding provider that is down. */
const offlineEmbedder: Embedder = {
  model: "offline",
  dimensions: 1536,
  embed: async () => {
    throw new Error("embedding provider unavailable");
  },
};

/**
 * A reranker that reorders deterministically and records what it was asked, so
 * the conversation context it receives is assertable without a network call.
 */
const fakeReranker = (opts?: {
  order?: (candidates: RerankCandidate[]) => RerankCandidate[];
}) => {
  const calls: Array<{ query: string; context?: string[] }> = [];

  const reranker: Reranker = {
    model: "fake",
    rerank: async ({ query, context, candidates }) => {
      calls.push({ query, context });
      return (opts?.order ?? ((given) => given))(candidates).map(
        (candidate) => candidate.id
      );
    },
  };

  return { calls, reranker };
};

/**
 * Reverses the chunks within each document while leaving the documents in the
 * order they arrived, so a test can change which passage wins without changing
 * which emails come back. Grouping goes through the module that owns the chunk
 * id scheme rather than re-implementing it here.
 */
const lastChunkOfEachDocumentFirst = (candidates: RerankCandidate[]) => {
  const byDocument = new Map<string, RerankCandidate[]>();

  for (const candidate of candidates) {
    const documentId = documentIdOfChunk(candidate.id);
    byDocument.set(documentId, [
      candidate,
      ...(byDocument.get(documentId) ?? []),
    ]);
  }

  return [...byDocument.values()].flat();
};

/** Stands in for a reranking provider that is down. */
const offlineReranker: Reranker = {
  model: "offline",
  rerank: async () => {
    throw new Error("rerank provider unavailable");
  },
};

/**
 * `execute` is optional on the SDK's `Tool` type and takes the call options a
 * model would supply — including the conversation so far, which is where this
 * tool reads its rerank context from. One helper keeps that noise out of every
 * test.
 */
const search = async (opts: {
  query: string;
  embedder: Embedder;
  reranker?: Reranker;
  messages?: ModelMessage[];
}): Promise<EmailSearchResult[]> => {
  const tool = createEmailSearchTool({
    embedder: opts.embedder,
    reranker: opts.reranker ?? fakeReranker().reranker,
  });

  if (!tool.execute) throw new Error("the tool must be executable");

  return (await tool.execute(
    { query: opts.query },
    { toolCallId: "test-call", messages: opts.messages ?? [] }
  )) as EmailSearchResult[];
};

const subjects = (results: EmailSearchResult[]) =>
  results.map((result) => result.subject);

describe("createEmailSearchTool", () => {
  const embedder = fixtureEmbedder();

  it("returns emails that are recognisably on topic", async () => {
    // Smoke test, not a relevance benchmark — asserted loosely on purpose.
    const results = await search({ query: "mortgage pre-approval", embedder });

    expect(results.length).toBeGreaterThan(0);
    expect(
      subjects(results).some((subject) => /mortgage/i.test(subject))
    ).toBe(true);
  });

  it("returns an empty array for a query that matches nothing", async () => {
    expect(await search({ query: "zzzzqqqxyzzy", embedder })).toEqual([]);
  });

  it("caps a broad query at the fixed result count", async () => {
    const results = await search({ query: "mortgage pre-approval", embedder });

    expect(results).toHaveLength(EMAIL_SEARCH_RESULT_COUNT);
  });

  it("returns only what matched when fewer than the cap match", async () => {
    // "deansgate" occurs in exactly one email; the cap is a ceiling, not padding.
    const results = await search({
      query: "deansgate",
      embedder: offlineEmbedder,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThan(EMAIL_SEARCH_RESULT_COUNT);
  });

  it("truncates bodies to the documented budget", async () => {
    const results = await search({ query: "mortgage pre-approval", embedder });

    for (const result of results) {
      expect(result.body.length).toBeLessThanOrEqual(
        EMAIL_SEARCH_BODY_CHARACTERS
      );
    }

    // …and the budget is actually reached, or this asserts nothing. It is the
    // degraded path that reaches it: a passage is bounded by the chunking
    // policy well below the budget, but a whole body is not, and that is what a
    // result falls back to when reranking is unavailable.
    const whole = await search({
      query: "what paperwork proves how much I earn",
      embedder,
      reranker: offlineReranker,
    });
    expect(
      whole.some((result) => result.body.length === EMAIL_SEARCH_BODY_CHARACTERS)
    ).toBe(true);
  });

  it("carries exactly the documented fields, and no score", async () => {
    const [result] = await search({ query: "mortgage pre-approval", embedder });

    expect(Object.keys(result).sort()).toEqual([
      "body",
      "from",
      "id",
      "subject",
      "timestamp",
    ]);
  });

  it("still returns lexical results when the embedder fails", async () => {
    const results = await search({
      query: "mortgage pre-approval",
      embedder: offlineEmbedder,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(
      subjects(results).some((subject) => /mortgage/i.test(subject))
    ).toBe(true);
  });

  it("returns the passage that won, not the opening of the email", async () => {
    // The corpus's long emails have more than one chunk, so which chunk wins is
    // observable: hold the documents in the same order and flip the chunks
    // within them, and the text changes for a message long enough to have two.
    const query = "what paperwork proves how much I earn";

    const first = await search({ query, embedder });
    const last = await search({
      query,
      embedder,
      reranker: fakeReranker({ order: lastChunkOfEachDocumentFirst }).reranker,
    });

    expect(last.map((result) => result.id)).toEqual(
      first.map((result) => result.id)
    );
    expect(
      first.some((result, index) => result.body !== last[index].body)
    ).toBe(true);
  });

  it("returns a self-contained passage, subject included", async () => {
    // The chunking policy prepends the subject, so a passage carries its own
    // context rather than arriving as a paragraph from nowhere.
    const results = await search({ query: "mortgage pre-approval", embedder });

    for (const result of results) {
      expect(result.body.startsWith(result.subject)).toBe(true);
    }
  });

  it("marks a passage that has more of the email after it", async () => {
    // The system prompt tells the model an ellipsis means "there is more of
    // this email than you are looking at". A passage from a chunked email has
    // to carry that mark, or it reads as a complete message that happens not to
    // mention what was asked about.
    const results = await search({
      query: "what paperwork proves how much I earn",
      embedder,
    });

    const chunked = results.filter((result) => {
      const email = getEmailById(result.id);
      // The chunking threshold: anything longer has more than one passage.
      return email !== undefined && email.body.length > 1500;
    });

    expect(chunked.length).toBeGreaterThan(0);
    for (const result of chunked) {
      expect(result.body.endsWith("…")).toBe(true);
    }
  });

  it("leaves a passage that is the whole email unmarked", async () => {
    const results = await search({ query: "mortgage pre-approval", embedder });

    const whole = results.filter((result) => {
      const email = getEmailById(result.id);
      return email !== undefined && email.body.length < 1000;
    });

    expect(whole.length).toBeGreaterThan(0);
    for (const result of whole) {
      expect(result.body.endsWith("…")).toBe(false);
    }
  });

  it("passes the recent user and assistant turns to the reranker", async () => {
    const { calls, reranker } = fakeReranker();

    await search({
      query: "mortgage pre-approval",
      embedder,
      reranker,
      messages: [
        { role: "user", content: "what did the broker say about the rate lock?" },
        { role: "assistant", content: "They confirmed the rate is locked." },
        { role: "user", content: "and what was the deadline on that?" },
      ],
    });

    const context = calls[0].context ?? [];
    expect(context.join("\n")).toContain("rate lock");
    expect(context.join("\n")).toContain("the rate is locked");
    // Oldest first, so the most recent turn is the last thing the reranker reads.
    expect(context.at(-1)).toContain("deadline");
  });

  it("keeps tool calls and tool results out of the rerank context", async () => {
    const { calls, reranker } = fakeReranker();

    await search({
      query: "mortgage pre-approval",
      embedder,
      reranker,
      messages: [
        { role: "system", content: "You are an assistant." },
        { role: "user", content: "what did the broker say?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me look." },
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "searchEmails",
              input: { query: "broker rate lock" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "searchEmails",
              output: {
                type: "json",
                value: [{ id: "email_1", subject: "Rate lock confirmation" }],
              },
            },
          ],
        },
      ],
    });

    const context = (calls[0].context ?? []).join("\n");
    expect(context).toContain("Let me look.");
    expect(context).not.toContain("searchEmails");
    expect(context).not.toContain("Rate lock confirmation");
    expect(context).not.toContain("You are an assistant.");
  });

  it("truncates the conversation to the documented depth", async () => {
    const { calls, reranker } = fakeReranker();

    await search({
      query: "mortgage pre-approval",
      embedder,
      reranker,
      messages: Array.from(
        { length: EMAIL_SEARCH_HISTORY_MESSAGES + 6 },
        (_, index): ModelMessage => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `turn ${index}`,
        })
      ),
    });

    const context = calls[0].context ?? [];
    expect(context).toHaveLength(EMAIL_SEARCH_HISTORY_MESSAGES);
    // The tail of the conversation, not its head.
    expect(context.at(-1)).toContain(
      `turn ${EMAIL_SEARCH_HISTORY_MESSAGES + 5}`
    );
    expect(context.join("\n")).not.toContain("turn 0");
  });

  it("bounds a single long turn rather than carrying it whole", async () => {
    // Six messages is not a bound on the prompt: one pasted document would ride
    // along in every rerank call for the rest of the conversation.
    const { calls, reranker } = fakeReranker();

    await search({
      query: "mortgage pre-approval",
      embedder,
      reranker,
      messages: [{ role: "user", content: "x".repeat(5000) }],
    });

    const [entry] = calls[0].context ?? [];
    expect(entry.length).toBeLessThan(EMAIL_SEARCH_HISTORY_CHARACTERS + 20);
  });

  it("searches on the very first turn, with no history at all", async () => {
    const { calls, reranker } = fakeReranker();

    const results = await search({
      query: "mortgage pre-approval",
      embedder,
      reranker,
      messages: [],
    });

    expect(results.length).toBeGreaterThan(0);
    expect(calls[0].context ?? []).toEqual([]);
  });

  it("still returns results when the reranker fails", async () => {
    const results = await search({
      query: "mortgage pre-approval",
      embedder,
      reranker: offlineReranker,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(
      subjects(results).some((subject) => /mortgage/i.test(subject))
    ).toBe(true);
  });

  it("still returns results when the embedder fails and the reranker works", async () => {
    const results = await search({
      query: "mortgage pre-approval",
      embedder: offlineEmbedder,
      reranker: fakeReranker({
        order: (candidates) => [...candidates].reverse(),
      }).reranker,
    });

    expect(results.length).toBeGreaterThan(0);
  });
});

describe("emailSearchInputSchema", () => {
  it("accepts a query", () => {
    expect(emailSearchInputSchema.safeParse({ query: "rate lock" }).success).toBe(
      true
    );
  });

  it("rejects a missing query before it reaches the ranker", () => {
    expect(emailSearchInputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty query", () => {
    expect(emailSearchInputSchema.safeParse({ query: "" }).success).toBe(false);
  });
});

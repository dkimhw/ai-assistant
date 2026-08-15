import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Embedder } from "@/lib/search/embedder";
import {
  createEmailSearchTool,
  EMAIL_SEARCH_BODY_CHARACTERS,
  EMAIL_SEARCH_RESULT_COUNT,
  emailSearchInputSchema,
  type EmailSearchResult,
} from "@/lib/search/email-search-tool";
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
 * `execute` is optional on the SDK's `Tool` type and takes the call options a
 * model would supply. One helper keeps that noise out of every test.
 */
const search = async (opts: {
  query: string;
  embedder: Embedder;
}): Promise<EmailSearchResult[]> => {
  const tool = createEmailSearchTool({ embedder: opts.embedder });

  if (!tool.execute) throw new Error("the tool must be executable");

  return (await tool.execute(
    { query: opts.query },
    { toolCallId: "test-call", messages: [] }
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

    // …and the budget is actually reached, or this asserts nothing.
    const longest = await search({
      query: "what paperwork proves how much I earn",
      embedder,
    });
    expect(
      longest.some(
        (result) => result.body.length === EMAIL_SEARCH_BODY_CHARACTERS
      )
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

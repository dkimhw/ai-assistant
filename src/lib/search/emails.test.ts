import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Embedder } from "@/lib/search/embedder";
import {
  getEmailIndex,
  getEmailSemanticIndex,
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

describe("searchEmails", () => {
  const embedder = fixtureEmbedder();

  it("indexes the whole corpus once", () => {
    expect(getEmailIndex()).toBe(getEmailIndex());
    expect(getEmailIndex().docCount).toBeGreaterThan(500);
  });

  it("builds the semantic index once, over one vector per distinct text", () => {
    expect(getEmailSemanticIndex()).toBe(getEmailSemanticIndex());
    // Fewer vectors than emails, because exact-duplicate texts are indexed once.
    expect(getEmailSemanticIndex().ids.length).toBeGreaterThan(400);
    expect(getEmailSemanticIndex().dimensions).toBe(1536);
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

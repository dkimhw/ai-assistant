import { describe, expect, it } from "vitest";
import { buildBM25Index, searchBM25 } from "@/lib/search/bm25";
import type { BM25Document } from "@/lib/search/bm25";

const docs = (entries: Array<[string, string]>): BM25Document[] =>
  entries.map(([id, body]) => ({ id, fields: { body } }));

const idsOf = (opts: {
  documents: BM25Document[];
  query: string;
  limit?: number;
}) =>
  searchBM25({
    index: buildBM25Index({ documents: opts.documents }),
    query: opts.query,
    limit: opts.limit,
  }).map((result) => result.id);

describe("searchBM25 — correctness", () => {
  it("ranks the only document containing a term first", () => {
    const results = idsOf({
      documents: docs([
        ["a", "mortgage paperwork"],
        ["b", "grocery shopping list"],
        ["c", "holiday photos"],
      ]),
      query: "mortgage",
    });

    expect(results).toEqual(["a"]);
  });

  it("weights a rarer term above a common one at equal tf", () => {
    // "common" appears in every document, "rare" only in the first.
    const documents = docs([
      ["rare-doc", "common rare filler filler"],
      ["common-1", "common filler filler filler"],
      ["common-2", "common filler filler filler"],
      ["common-3", "common filler filler filler"],
    ]);
    const index = buildBM25Index({ documents });

    const rareScore = searchBM25({ index, query: "rare" })[0].score;
    const commonScore = searchBM25({ index, query: "common" })[0].score;

    expect(rareScore).toBeGreaterThan(commonScore);
  });

  it("prefers the shorter document at equal tf when b = 0.75, and ties when b = 0", () => {
    const documents = docs([
      ["short", "mortgage advice"],
      [
        "long",
        "mortgage advice plus plenty more unrelated padding words trailing along here",
      ],
    ]);

    const normalised = searchBM25({
      index: buildBM25Index({ documents, b: 0.75 }),
      query: "mortgage",
    });
    expect(normalised[0].id).toBe("short");
    expect(normalised[0].score).toBeGreaterThan(normalised[1].score);

    const unnormalised = searchBM25({
      index: buildBM25Index({ documents, b: 0 }),
      query: "mortgage",
    });
    expect(unnormalised[0].score).toBeCloseTo(unnormalised[1].score, 12);
  });

  it("saturates term frequency", () => {
    const once = buildBM25Index({
      documents: docs([
        ["a", "mortgage"],
        ["b", "unrelated"],
      ]),
    });
    const tenTimes = buildBM25Index({
      documents: docs([
        ["a", Array(10).fill("mortgage").join(" ")],
        ["b", "unrelated"],
      ]),
    });

    const onceScore = searchBM25({ index: once, query: "mortgage" })[0].score;
    const tenScore = searchBM25({ index: tenTimes, query: "mortgage" })[0]
      .score;

    expect(tenScore).toBeGreaterThan(onceScore);
    expect(tenScore).toBeLessThan(onceScore * 10);
  });

  it("ranks a subject-only match above a body-only match under email field weights", () => {
    const index = buildBM25Index({
      documents: [
        {
          id: "subject-match",
          fields: { subject: "mortgage renewal", body: "filler text here" },
        },
        {
          id: "body-match",
          fields: { subject: "renewal notes", body: "mortgage filler text" },
        },
      ],
      fieldWeights: { subject: 3, body: 1 },
    });

    const results = searchBM25({ index, query: "mortgage" });

    expect(results.map((result) => result.id)).toEqual([
      "subject-match",
      "body-match",
    ]);
  });

  it("reports only the query terms present in the index as matchedTerms", () => {
    const index = buildBM25Index({
      documents: docs([
        ["a", "mortgage advice"],
        ["b", "advice column"],
      ]),
    });

    const [top] = searchBM25({ index, query: "mortgage advice unicorn" });

    expect(top.id).toBe("a");
    expect(top.matchedTerms).toEqual(["mortgage", "advice"]);
  });

  it("de-duplicates repeated query terms", () => {
    const index = buildBM25Index({
      documents: docs([
        ["a", "mortgage advice"],
        ["b", "advice column"],
      ]),
    });

    const single = searchBM25({ index, query: "mortgage" })[0].score;
    const repeated = searchBM25({ index, query: "mortgage mortgage" })[0].score;

    expect(repeated).toBeCloseTo(single, 12);
  });

  it("matches a hand-computed score on a toy corpus", () => {
    const documents: BM25Document[] = [
      { id: "d1", fields: { subject: "mortgage", body: "mortgage advice" } },
      { id: "d2", fields: { subject: "advice", body: "mortgage" } },
      { id: "d3", fields: { subject: "holiday", body: "photos of a beach" } },
    ];
    const fieldWeights = { subject: 3, body: 1 };
    const k1 = 1.2;
    const b = 0.75;

    // Tokenised (stopwords/1-char dropped):
    //   d1 subject ["mortgage"](1)      body ["mortgage","advice"](2)
    //   d2 subject ["advice"](1)        body ["mortgage"](1)
    //   d3 subject ["holiday"](1)       body ["photos","beach"](2)
    // avg subject length = 1, avg body length = 5/3
    const avgSubject = 1;
    const avgBody = 5 / 3;

    // "mortgage": df = 2, N = 3
    const idf = Math.log(1 + (3 - 2 + 0.5) / (2 + 0.5));

    const norm = (opts: { length: number; avg: number }) =>
      1 - b + b * (opts.length / opts.avg);

    // d1: subject tf 1, body tf 1
    const tfD1 =
      (3 * 1) / norm({ length: 1, avg: avgSubject }) +
      (1 * 1) / norm({ length: 2, avg: avgBody });
    const scoreD1 = (idf * (tfD1 * (k1 + 1))) / (tfD1 + k1);

    // d2: subject tf 0, body tf 1
    const tfD2 = (1 * 1) / norm({ length: 1, avg: avgBody });
    const scoreD2 = (idf * (tfD2 * (k1 + 1))) / (tfD2 + k1);

    const results = searchBM25({
      index: buildBM25Index({ documents, fieldWeights }),
      query: "mortgage",
    });

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("d1");
    expect(results[0].score).toBeCloseTo(scoreD1, 6);
    expect(results[1].id).toBe("d2");
    expect(results[1].score).toBeCloseTo(scoreD2, 6);
  });

  it("breaks ties by ascending document index", () => {
    const results = idsOf({
      documents: docs([
        ["first", "mortgage advice"],
        ["second", "mortgage advice"],
        ["third", "mortgage advice"],
      ]),
      query: "mortgage",
    });

    expect(results).toEqual(["first", "second", "third"]);
  });

  it("honours limit and defaults it to 10", () => {
    const documents = docs(
      Array.from(
        { length: 12 },
        (_, i) => [`d${i}`, "mortgage advice"] as [string, string]
      )
    );
    const index = buildBM25Index({ documents });

    expect(searchBM25({ index, query: "mortgage" })).toHaveLength(10);
    expect(searchBM25({ index, query: "mortgage", limit: 3 })).toHaveLength(3);
  });
});

describe("searchBM25 — edges", () => {
  const index = buildBM25Index({
    documents: docs([
      ["a", "mortgage advice"],
      ["b", "holiday photos"],
    ]),
  });

  it("returns [] for an empty query", () => {
    expect(searchBM25({ index, query: "" })).toEqual([]);
    expect(searchBM25({ index, query: "   " })).toEqual([]);
  });

  it("returns [] for a stopword-only query", () => {
    expect(searchBM25({ index, query: "the and of it" })).toEqual([]);
  });

  it("returns [] when no query term is in the index", () => {
    expect(searchBM25({ index, query: "unicorn" })).toEqual([]);
  });

  it("handles an empty corpus without dividing by zero", () => {
    const empty = buildBM25Index({ documents: [] });
    const results = searchBM25({ index: empty, query: "mortgage" });

    expect(results).toEqual([]);
  });

  it("keeps IDF positive on a single-document corpus", () => {
    const single = buildBM25Index({ documents: docs([["only", "mortgage"]]) });
    const [result] = searchBM25({ index: single, query: "mortgage" });

    expect(result.id).toBe("only");
    expect(result.score).toBeGreaterThan(0);
  });

  it("handles a document with an empty field", () => {
    const withEmpty = buildBM25Index({
      documents: [
        { id: "a", fields: { subject: "", body: "mortgage advice" } },
        { id: "b", fields: { subject: "mortgage", body: "" } },
      ],
      fieldWeights: { subject: 3, body: 1 },
    });
    const results = searchBM25({ index: withEmpty, query: "mortgage" });

    expect(results.map((result) => result.id)).toEqual(["b", "a"]);
    expect(results.every((result) => Number.isFinite(result.score))).toBe(true);
  });

  it("tolerates a limit larger than the result count", () => {
    expect(searchBM25({ index, query: "mortgage", limit: 100 })).toHaveLength(
      1
    );
  });

  it("drops documents at or below minScore", () => {
    expect(
      searchBM25({ index, query: "mortgage", minScore: 1000 })
    ).toHaveLength(0);
  });
});

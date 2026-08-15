import { describe, expect, it } from "vitest";
import {
  getDocument,
  searchDocuments,
  type DocumentSource,
  type SourceDocument,
} from "@/lib/search/documents";
import type { Embedder } from "@/lib/search/embedder";

/**
 * Cross-source behaviour, exercised through the one public seam with in-memory
 * fake sources. `sources` is a parameter for the same reason `embedder` is: a
 * second kind of document can be proved to work without a second real corpus
 * and without a mock.
 *
 * Nothing here asserts on the id scheme itself — only on behaviour that would
 * break if it were wrong. The `:` and `#` conventions should be replaceable
 * without touching this file.
 */

const documentsFrom = (
  entries: Array<[nativeId: string, text: string]>
): SourceDocument[] =>
  entries.map(([nativeId, text]) => ({
    nativeId,
    fields: { body: text },
    chunkText: text,
  }));

const source = (opts: {
  sourceType: string;
  documents: SourceDocument[];
  hasNativeIds?: boolean;
}): DocumentSource => ({
  sourceType: opts.sourceType,
  fieldWeights: { body: 1 },
  hasNativeIds: opts.hasNativeIds,
  all: () => opts.documents,
  // One chunk per document unless a test says otherwise; the chunk id
  // convention is the layer's, reached through the document id it is given.
  chunk: ({ document }) => [
    { id: `${document.id}#0`, text: document.chunkText },
  ],
});

/** Never called: these tests are lexical unless they say otherwise. */
const noEmbedder: Embedder = {
  model: "offline",
  dimensions: 3,
  embed: async () => {
    throw new Error("embedding provider unavailable");
  },
};

const ids = (results: Array<{ document: { id: string } }>) =>
  results.map((result) => result.document.id);

describe("searchDocuments", () => {
  it("keeps two sources apart when they mint the same native id", async () => {
    const sources = [
      source({
        sourceType: "email",
        documents: documentsFrom([["shared-1", "quarterly budget review"]]),
      }),
      source({
        sourceType: "note",
        documents: documentsFrom([["shared-1", "budget notes from the review"]]),
      }),
    ];

    const results = await searchDocuments({
      query: "budget review",
      sources,
      embedder: noEmbedder,
    });

    expect(results).toHaveLength(2);
    expect(new Set(ids(results)).size).toBe(2);
    expect(results.map((result) => result.document.sourceType).sort()).toEqual([
      "email",
      "note",
    ]);
  });

  it("labels each result with the source that supplied it", async () => {
    const sources = [
      source({
        sourceType: "email",
        documents: documentsFrom([["a", "kayak hire on the lake"]]),
      }),
      source({
        sourceType: "note",
        documents: documentsFrom([["b", "kayak repair kit"]]),
      }),
    ];

    const results = await searchDocuments({
      query: "kayak",
      sources,
      embedder: noEmbedder,
    });

    for (const result of results) {
      const owner = sources.find(
        (candidate) => candidate.sourceType === result.document.sourceType
      );
      expect(owner).toBeDefined();
      expect(owner?.all().map((document) => document.fields.body)).toContain(
        result.document.fields.body
      );
    }
  });

  it("rejects a native id containing a reserved character, naming the id", async () => {
    for (const nativeId of ["has:colon", "has#hash"]) {
      const sources = [
        source({
          sourceType: "note",
          documents: documentsFrom([[nativeId, "some text"]]),
        }),
      ];

      await expect(
        searchDocuments({ query: "text", sources, embedder: noEmbedder })
      ).rejects.toThrow(nativeId);
    }
  });

  it("gives a source with no native ids stable ids derived from its content", async () => {
    const withoutIds = (text: string): DocumentSource =>
      source({
        sourceType: "note",
        hasNativeIds: false,
        documents: [{ fields: { body: text }, chunkText: text }],
      });

    const search = (documentSource: DocumentSource) =>
      searchDocuments({
        query: "loose",
        sources: [documentSource],
        embedder: noEmbedder,
      });

    const first = await search(withoutIds("a loose note"));
    const again = await search(withoutIds("a loose note"));
    const other = await search(withoutIds("a loose thought"));

    expect(ids(first)).toEqual(ids(again));
    expect(ids(first)).not.toEqual(ids(other));
  });

  it("returns one result per document, not one per chunk", async () => {
    const chunked: DocumentSource = {
      ...source({
        sourceType: "note",
        documents: documentsFrom([["long", "otter otter otter"]]),
      }),
      chunk: ({ document }) =>
        ["otter sighting", "otter again", "otter once more"].map(
          (text, index) => ({ id: `${document.id}#${index}`, text })
        ),
    };

    const results = await searchDocuments({
      query: "otter",
      sources: [chunked],
      embedder: noEmbedder,
    });

    expect(results).toHaveLength(1);
  });

  it("ranks by meaning when the source has vectors, collapsing chunks to one result", async () => {
    const vector = (values: number[]) => Float32Array.from(values);

    const semantic: DocumentSource = {
      ...source({
        sourceType: "note",
        documents: documentsFrom([
          ["kayak", "paddling"],
          ["ledger", "accounts"],
        ]),
      }),
      vectors: ({ chunks }) =>
        chunks.map((chunk) => ({
          id: chunk.id,
          vector: chunk.id.includes("kayak")
            ? vector([1, 0, 0])
            : vector([0, 1, 0]),
        })),
    };

    const results = await searchDocuments({
      // Shares no term with either document: only the vector can find it.
      query: "rowing",
      sources: [semantic],
      embedder: {
        model: "fixture",
        dimensions: 3,
        embed: async () => [vector([1, 0, 0])],
      },
    });

    expect(ids(results)).toEqual(["note:kayak"]);
  });

  it("falls back to lexical-only ranking when the embedder rejects", async () => {
    const semantic: DocumentSource = {
      ...source({
        sourceType: "note",
        documents: documentsFrom([["kayak", "paddling downstream"]]),
      }),
      vectors: ({ chunks }) =>
        chunks.map((chunk) => ({ id: chunk.id, vector: Float32Array.from([1, 0, 0]) })),
    };

    const results = await searchDocuments({
      query: "paddling",
      sources: [semantic],
      embedder: noEmbedder,
    });

    expect(ids(results)).toEqual(["note:kayak"]);
  });

  it("returns [] for an empty query without embedding it", async () => {
    const sources = [
      source({ sourceType: "note", documents: documentsFrom([["a", "text"]]) }),
    ];

    expect(
      await searchDocuments({ query: "   ", sources, embedder: noEmbedder })
    ).toEqual([]);
  });

  it("refuses to index a source that mints one id for two documents", async () => {
    // Hashed ids come from the text, so two identical documents collide. Left
    // alone, the by-id map keeps the last and the first becomes unreachable.
    const duplicates = source({
      sourceType: "note",
      hasNativeIds: false,
      documents: ["the same note", "the same note"].map((text) => ({
        fields: { body: text },
        chunkText: text,
      })),
    });

    await expect(
      searchDocuments({
        query: "note",
        sources: [duplicates],
        embedder: noEmbedder,
      })
    ).rejects.toThrow(/two documents/);
  });

  it("refuses a vector for a chunk the source does not have", async () => {
    const mismatched: DocumentSource = {
      ...source({
        sourceType: "note",
        documents: documentsFrom([["a", "some text"]]),
      }),
      // What a chunking change without a rebuild looks like from here.
      vectors: () => [
        { id: "note:a#7", vector: Float32Array.from([1, 0, 0]) },
      ],
    };

    await expect(
      searchDocuments({ query: "text", sources: [mismatched], embedder: noEmbedder })
    ).rejects.toThrow(/note:a#7/);
  });

  it("indexes a set of sources once, however many queries run against it", async () => {
    // A performance contract with an invisible failure mode: without the memo
    // every query re-reads the corpus and rebuilds both indexes, which is
    // latency rather than a wrong answer.
    let reads = 0;
    const counted: DocumentSource[] = [
      {
        ...source({
          sourceType: "note",
          documents: documentsFrom([["a", "kayak hire"]]),
        }),
        all: () => {
          reads++;
          return documentsFrom([["a", "kayak hire"]]);
        },
      },
    ];

    await searchDocuments({ query: "kayak", sources: counted, embedder: noEmbedder });
    await searchDocuments({ query: "hire", sources: counted, embedder: noEmbedder });

    expect(reads).toBe(1);
  });

  it("narrows to the wanted sources before applying the limit", async () => {
    const sources = [
      source({
        sourceType: "email",
        documents: documentsFrom([
          ["a", "otter otter otter"],
          ["b", "otter otter"],
        ]),
      }),
      source({
        sourceType: "note",
        // Ranks above both emails, so an unfiltered top 1 would be this.
        documents: documentsFrom([["c", "otter"]]),
      }),
    ];

    const results = await searchDocuments({
      query: "otter",
      limit: 1,
      sourceTypes: ["email"],
      sources,
      embedder: noEmbedder,
    });

    expect(results).toHaveLength(1);
    expect(results[0].document.sourceType).toBe("email");
  });

  it("does not embed the query when no source has vectors", async () => {
    // Counting calls, which this suite otherwise avoids: a wasted embedding
    // round-trip is cost and latency, and it is invisible in the result.
    let embeddings = 0;
    const counting: Embedder = {
      model: "counting",
      dimensions: 3,
      embed: async () => {
        embeddings++;
        return [Float32Array.from([1, 0, 0])];
      },
    };

    await searchDocuments({
      query: "kayak",
      sources: [
        source({
          sourceType: "note",
          documents: documentsFrom([["a", "kayak hire"]]),
        }),
      ],
      embedder: counting,
    });

    expect(embeddings).toBe(0);
  });

  it("refuses to index two sources that disagree on a field's weight", async () => {
    const sources = [
      source({ sourceType: "email", documents: documentsFrom([["a", "text"]]) }),
      {
        ...source({
          sourceType: "note",
          documents: documentsFrom([["b", "text"]]),
        }),
        fieldWeights: { body: 5 },
      },
    ];

    await expect(
      searchDocuments({ query: "text", sources, embedder: noEmbedder })
    ).rejects.toThrow(/body/);
  });
});

describe("getDocument", () => {
  const sources = [
    source({
      sourceType: "note",
      documents: documentsFrom([["a", "a loose note"]]),
    }),
  ];

  it("routes an id to the source that owns it", () => {
    expect(getDocument({ id: "note:a", sources })?.fields.body).toBe(
      "a loose note"
    );
  });

  it("returns undefined for an id its source no longer has", () => {
    expect(getDocument({ id: "note:gone", sources })).toBeUndefined();
  });

  it("names the unknown type and the registered ones", () => {
    expect(() => getDocument({ id: "invoice:a", sources })).toThrow(
      /invoice[\s\S]*note/
    );
  });
});

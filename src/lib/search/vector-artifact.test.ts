import { describe, expect, it } from "vitest";
import {
  assertArtifactMatches,
  decodeVectors,
  encodeVectors,
  fingerprintChunks,
  type VectorArtifact,
} from "@/lib/search/vector-artifact";

/**
 * The staleness check is the only thing standing between a forgotten
 * `pnpm run build:vectors` and search that silently ranks against vectors for
 * text that no longer exists. Its failure mode is invisible, so it is pinned
 * here rather than left to the adapter's smoke tests.
 */

const chunks = [
  { id: "email:a#0", text: "hello" },
  { id: "email:b#0", text: "world" },
];

const artifact = (overrides?: Partial<VectorArtifact>): VectorArtifact => ({
  model: "text-embedding-3-small",
  dimensions: 2,
  fingerprint: fingerprintChunks({ chunks }),
  ids: chunks.map((chunk) => chunk.id),
  vectors: encodeVectors({
    vectors: [Float32Array.from([1, 0]), Float32Array.from([0, 1])],
  }),
  ...overrides,
});

const matching = {
  model: "text-embedding-3-small",
  dimensions: 2,
  fingerprint: fingerprintChunks({ chunks }),
  rebuildCommand: "pnpm run build:vectors",
};

describe("encode / decode", () => {
  it("round-trips vectors through base64 Float32", () => {
    const vectors = [
      Float32Array.from([0.5, -0.25, 0.125]),
      Float32Array.from([1, 0, -1]),
    ];

    const decoded = decodeVectors({
      vectors: encodeVectors({ vectors }),
      dimensions: 3,
    });

    expect(decoded).toHaveLength(2);
    expect([...decoded[0]]).toEqual([0.5, -0.25, 0.125]);
    expect([...decoded[1]]).toEqual([1, 0, -1]);
  });

  it("refuses to decode at zero dimensions rather than looping forever", () => {
    expect(() => decodeVectors({ vectors: "", dimensions: 0 })).toThrow();
  });
});

describe("fingerprintChunks", () => {
  const withTexts = (texts: string[]) =>
    fingerprintChunks({
      chunks: texts.map((text, index) => ({ id: `s:${index}#0`, text })),
    });

  it("distinguishes a merged text from two separate ones", () => {
    expect(withTexts(["a", "b"])).not.toBe(withTexts(["a b"]));
    expect(withTexts(["a", "b"])).not.toBe(withTexts(["ab"]));
  });

  it("is stable for identical input", () => {
    expect(withTexts(["one", "two"])).toBe(withTexts(["one", "two"]));
  });

  it("moves when only the ids change, leaving every text alone", () => {
    // The migration trap: namespacing ids changes no text, so a fingerprint over
    // texts alone would keep accepting an artifact whose ids no longer resolve.
    expect(fingerprintChunks({ chunks })).not.toBe(
      fingerprintChunks({
        chunks: chunks.map((chunk) => ({ ...chunk, id: chunk.id.slice(6) })),
      })
    );
  });
});

describe("assertArtifactMatches", () => {
  it("accepts an artifact built from the current corpus", () => {
    expect(() =>
      assertArtifactMatches({ artifact: artifact(), ...matching })
    ).not.toThrow();
  });

  it("throws when the corpus has changed since the build", () => {
    expect(() =>
      assertArtifactMatches({
        artifact: artifact(),
        ...matching,
        fingerprint: fingerprintChunks({
          chunks: [chunks[0], { id: "email:b#0", text: "moon" }],
        }),
      })
    ).toThrow(/stale[\s\S]*build:vectors/);
  });

  it("throws when the texts still match but the id scheme has changed", () => {
    // Every text is byte-identical; only the source namespace on the ids is
    // missing. Accepting this artifact would look like a working search that
    // returns nothing, because no id would resolve to a document.
    const oldScheme = chunks.map((chunk) => ({
      ...chunk,
      id: chunk.id.slice("email:".length),
    }));

    expect(() =>
      assertArtifactMatches({
        artifact: artifact({
          fingerprint: fingerprintChunks({ chunks: oldScheme }),
          ids: oldScheme.map((chunk) => chunk.id),
        }),
        ...matching,
      })
    ).toThrow(/stale[\s\S]*build:vectors/);
  });

  it("throws when the configured model has changed", () => {
    expect(() =>
      assertArtifactMatches({
        artifact: artifact(),
        ...matching,
        model: "text-embedding-3-large",
      })
    ).toThrow(/stale/);
  });

  it("throws when the configured dimension count has changed", () => {
    expect(() =>
      assertArtifactMatches({ artifact: artifact(), ...matching, dimensions: 512 })
    ).toThrow(/stale/);
  });

  it("throws when the packed vectors do not match the id count", () => {
    expect(() =>
      assertArtifactMatches({
        artifact: artifact({ ids: ["a#0", "b#0", "c#0"] }),
        ...matching,
      })
    ).toThrow(/corrupt/);
  });
});

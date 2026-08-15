import { describe, expect, it } from "vitest";
import {
  assertArtifactMatches,
  decodeVectors,
  encodeVectors,
  fingerprintTexts,
  type VectorArtifact,
} from "@/lib/search/vector-artifact";

/**
 * The staleness check is the only thing standing between a forgotten
 * `pnpm run build:vectors` and search that silently ranks against vectors for
 * text that no longer exists. Its failure mode is invisible, so it is pinned
 * here rather than left to the adapter's smoke tests.
 */

const artifact = (overrides?: Partial<VectorArtifact>): VectorArtifact => ({
  model: "text-embedding-3-small",
  dimensions: 2,
  fingerprint: fingerprintTexts({ texts: ["hello", "world"] }),
  ids: ["a#0", "b#0"],
  vectors: encodeVectors({
    vectors: [Float32Array.from([1, 0]), Float32Array.from([0, 1])],
  }),
  ...overrides,
});

const matching = {
  model: "text-embedding-3-small",
  dimensions: 2,
  fingerprint: fingerprintTexts({ texts: ["hello", "world"] }),
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

describe("fingerprintTexts", () => {
  it("distinguishes a merged text from two separate ones", () => {
    expect(fingerprintTexts({ texts: ["a", "b"] })).not.toBe(
      fingerprintTexts({ texts: ["a b"] })
    );
    expect(fingerprintTexts({ texts: ["a", "b"] })).not.toBe(
      fingerprintTexts({ texts: ["ab"] })
    );
  });

  it("is stable for identical input", () => {
    expect(fingerprintTexts({ texts: ["one", "two"] })).toBe(
      fingerprintTexts({ texts: ["one", "two"] })
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
        fingerprint: fingerprintTexts({ texts: ["hello", "moon"] }),
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

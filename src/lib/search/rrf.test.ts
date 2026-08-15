import { describe, expect, it } from "vitest";
import { fuseRRF } from "@/lib/search/rrf";

/**
 * `fuseRRF` is pure rank arithmetic, so these are exhaustive rather than loose.
 * Expected numbers are transcribed from the definition
 *   score(id) = Σ 1 / (k + rank)     with rank 1-based
 * and never derived by calling the implementation.
 */

const ids = (results: Array<{ id: string }>) => results.map((r) => r.id);

describe("fuseRRF — correctness", () => {
  it("matches the hand-computed RRF score", () => {
    // k = 60. "b" is 2nd in the first ranking and 1st in the second:
    //   1/62 + 1/61 = 0.016129032 + 0.016393443 = 0.032522475
    const fused = fuseRRF({
      rankings: [
        ["a", "b"],
        ["b", "c"],
      ],
    });

    expect(fused[0].id).toBe("b");
    expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61, 9);
    // "a" is 1st in one ranking only: 1/61.
    expect(fused.find((r) => r.id === "a")?.score).toBeCloseTo(1 / 61, 9);
    // "c" is 2nd in one ranking only: 1/62.
    expect(fused.find((r) => r.id === "c")?.score).toBeCloseTo(1 / 62, 9);
  });

  it("ranks an id found by both rankings above one found by a single ranking", () => {
    const fused = fuseRRF({
      rankings: [
        ["solo", "both"],
        ["both"],
      ],
    });

    expect(ids(fused)).toEqual(["both", "solo"]);
  });

  it("keeps a top-ranked id competitive when the other ranking misses it", () => {
    // "lexical" is #1 in one list and absent from the other; "mid" is #4 and #4.
    const fused = fuseRRF({
      rankings: [
        ["lexical", "x", "y", "mid"],
        ["p", "q", "r", "mid"],
      ],
    });

    // "mid" agrees across both lists: 1/64 + 1/64 = 0.03125, which beats the
    // 1/61 = 0.01639 that a single first place is worth.
    expect(ids(fused)[0]).toBe("mid");
    // The single-list #1 still places second (tied with "p", the other list's
    // #1, and ahead of it by the first-appearance tie-break).
    expect(ids(fused)[1]).toBe("lexical");
  });

  it("orders by descending fused score", () => {
    const fused = fuseRRF({
      rankings: [
        ["a", "b", "c"],
        ["c", "b", "a"],
      ],
    });

    expect(fused[0].score).toBeGreaterThanOrEqual(fused[1].score);
    expect(fused[1].score).toBeGreaterThanOrEqual(fused[2].score);
    // 1/(k+r) is convex, so disagreement (1st + 3rd = 1/61 + 1/63) edges out
    // agreement in the middle (2nd + 2nd = 2/62). A tiny margin, but it is the
    // documented behaviour of the formula, not an accident of the sort.
    expect(ids(fused)).toEqual(["a", "c", "b"]);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 63, 9);
    expect(fused[2].score).toBeCloseTo(2 / 62, 9);
  });

  it("ignores duplicate ids within one ranking, keeping the best position", () => {
    const fused = fuseRRF({ rankings: [["a", "b", "a"]] });

    expect(ids(fused)).toEqual(["a", "b"]);
    expect(fused[0].score).toBeCloseTo(1 / 61, 9);
  });
});

describe("fuseRRF — determinism", () => {
  it("breaks ties by first appearance across the rankings, in order", () => {
    // "a" and "b" are both rank 1 in one list each, so their scores are equal.
    const fused = fuseRRF({
      rankings: [["a"], ["b"]],
    });

    expect(fused[0].score).toBeCloseTo(fused[1].score, 12);
    expect(ids(fused)).toEqual(["a", "b"]);
  });

  it("produces identical output for identical input", () => {
    const rankings = [
      ["a", "b", "c", "d"],
      ["d", "c", "b", "a"],
      ["b", "d"],
    ];

    expect(fuseRRF({ rankings })).toEqual(fuseRRF({ rankings }));
  });
});

describe("fuseRRF — the smoothing constant", () => {
  it("shrinks every score monotonically as k grows", () => {
    const rankings = [["a", "b"]];
    const small = fuseRRF({ rankings, k: 10 });
    const large = fuseRRF({ rankings, k: 100 });

    expect(small[0].score).toBeGreaterThan(large[0].score);
    expect(small[0].score).toBeCloseTo(1 / 11, 9);
    expect(large[0].score).toBeCloseTo(1 / 101, 9);
  });

  it("flattens the gap between adjacent ranks as k grows", () => {
    const rankings = [["a", "b"]];
    const gapAt1 = (() => {
      const [first, second] = fuseRRF({ rankings, k: 1 });
      return first.score - second.score;
    })();
    const gapAt1000 = (() => {
      const [first, second] = fuseRRF({ rankings, k: 1000 });
      return first.score - second.score;
    })();

    expect(gapAt1).toBeGreaterThan(gapAt1000);
  });

  it("makes rank position dominate over agreement at k = 0", () => {
    // At k = 0 the #1 slot is worth 1.0, which two #3 placements cannot match.
    const fused = fuseRRF({
      rankings: [
        ["top", "x", "shared"],
        ["y", "z", "shared"],
      ],
      k: 0,
    });

    expect(ids(fused)[0]).toBe("top");
    expect(fused[0].score).toBeCloseTo(1, 9);
  });
});

describe("fuseRRF — edges", () => {
  it("degrades to the other ranking's order when one is empty", () => {
    const fused = fuseRRF({ rankings: [["a", "b", "c"], []] });

    expect(ids(fused)).toEqual(["a", "b", "c"]);
  });

  it("returns [] when every ranking is empty", () => {
    expect(fuseRRF({ rankings: [[], []] })).toEqual([]);
  });

  it("returns [] when there are no rankings at all", () => {
    expect(fuseRRF({ rankings: [] })).toEqual([]);
  });

  it("handles a single ranking, preserving its order", () => {
    expect(ids(fuseRRF({ rankings: [["a", "b", "c"]] }))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("fuses more than two rankings", () => {
    const fused = fuseRRF({
      rankings: [
        ["a", "b"],
        ["b", "a"],
        ["b", "a"],
      ],
    });

    expect(ids(fused)).toEqual(["b", "a"]);
  });

  it("honours limit", () => {
    const fused = fuseRRF({ rankings: [["a", "b", "c", "d"]], limit: 2 });

    expect(ids(fused)).toEqual(["a", "b"]);
  });

  it("returns everything when limit exceeds the candidate count", () => {
    expect(fuseRRF({ rankings: [["a"]], limit: 99 })).toHaveLength(1);
  });
});

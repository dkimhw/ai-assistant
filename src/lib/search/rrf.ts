/**
 * Reciprocal Rank Fusion. Pure: no I/O, no async, no knowledge of the rankers
 * whose output it combines.
 *
 *   score(id) = Σ over rankings of  1 / (k + rank(id))      // rank is 1-based
 *
 * Combining by *position* rather than by score is the whole point. BM25 scores
 * are unbounded and corpus-relative; cosine similarities are bounded to [-1, 1].
 * There is no principled way to add them, and normalising per query is unstable
 * on small result sets. RRF throws the incomparable magnitudes away and keeps
 * the only thing fusion actually needs — the ordering.
 */

export type RRFResult = {
  id: string;
  /** Bounded by (number of rankings) / (k + 1). An ordering signal, not a probability. */
  score: number;
};

/**
 * The conventional default from Cormack et al. (2009). Large relative to the
 * result sizes here, so no single ranking's first place can dominate agreement
 * between rankings.
 */
const DEFAULT_K = 60;

export const fuseRRF = (opts: {
  /** Each entry is one ranker's ids, best first. Ids absent from a ranking contribute nothing from it. */
  rankings: string[][];
  k?: number;
  limit?: number;
}): RRFResult[] => {
  const { rankings, k = DEFAULT_K, limit } = opts;

  // Insertion order doubles as the tie-break: ids first seen in an earlier
  // ranking, at a better position, sort first at equal score.
  const scores = new Map<string, number>();

  for (const ranking of rankings) {
    const seen = new Set<string>();

    ranking.forEach((id, index) => {
      // A duplicate within one ranking keeps its best position and scores once.
      if (seen.has(id)) return;
      seen.add(id);

      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }

  // Array.prototype.sort is stable, so equal scores retain insertion order.
  const fused = [...scores.entries()]
    .sort(([, scoreA], [, scoreB]) => scoreB - scoreA)
    .map(([id, score]) => ({ id, score }));

  return limit === undefined ? fused : fused.slice(0, limit);
};

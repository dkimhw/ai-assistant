/**
 * Corpus-agnostic semantic ranker. Knows nothing about emails — callers supply
 * documents as `{ id, vector }` and query with a vector of the same dimension.
 *
 *   score(d) = cos(q, d) = q · d          // for L2-normalised q and d
 *
 * Every vector is normalised when it is produced (at build time for documents,
 * at query time for queries), so cosine similarity collapses to a plain dot
 * product and the scoring loop has no per-query magnitude arithmetic in it.
 *
 * The scan is exhaustive. At ~900 vectors × 1536 dimensions that is around a
 * million multiply-adds — sub-millisecond, and exact. An approximate-nearest-
 * neighbour index would add a dependency and approximation error to solve a
 * problem this corpus does not have.
 */

export type SemanticDocument = {
  id: string;
  /** L2-normalised, all of the same length. */
  vector: Float32Array;
};

export type SemanticIndex = {
  ids: string[];
  /** All document vectors end to end: document `i` occupies `[i·d, (i+1)·d)`. */
  vectors: Float32Array;
  dimensions: number;
};

export type SemanticResult = {
  id: string;
  /** Cosine similarity in [-1, 1]. Comparable across queries, unlike a BM25 score. */
  score: number;
};

const DEFAULT_LIMIT = 10;

export const buildSemanticIndex = (opts: {
  documents: SemanticDocument[];
}): SemanticIndex => {
  const { documents } = opts;

  const dimensions = documents[0]?.vector.length ?? 0;

  const mismatch = documents.find(
    (document) => document.vector.length !== dimensions
  );
  if (mismatch) {
    throw new Error(
      `Vector for "${mismatch.id}" has ${mismatch.vector.length} dimensions, expected ${dimensions}.`
    );
  }

  const vectors = new Float32Array(documents.length * dimensions);
  documents.forEach((document, doc) => {
    vectors.set(document.vector, doc * dimensions);
  });

  return {
    ids: documents.map((document) => document.id),
    vectors,
    dimensions,
  };
};

export const searchSemantic = (opts: {
  index: SemanticIndex;
  queryVector: Float32Array;
  limit?: number;
  /** Cosine floor. Results at or below it are dropped, so a query about nothing in the corpus returns nothing. */
  minScore?: number;
}): SemanticResult[] => {
  const { index, queryVector, limit = DEFAULT_LIMIT, minScore = 0 } = opts;
  const { ids, vectors, dimensions } = index;

  if (dimensions === 0) return [];

  if (queryVector.length !== dimensions) {
    throw new Error(
      `Query vector has ${queryVector.length} dimensions, index has ${dimensions}.`
    );
  }

  const scored: SemanticResult[] = [];

  for (let doc = 0; doc < ids.length; doc++) {
    const offset = doc * dimensions;

    let score = 0;
    for (let component = 0; component < dimensions; component++) {
      score += queryVector[component] * vectors[offset + component];
    }

    if (score > minScore) scored.push({ id: ids[doc], score });
  }

  // Ties break by ascending document index, matching the BM25 ranker: sort is
  // stable and `scored` is already in index order.
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
};

/**
 * Scale a vector to unit length. Returns a zero vector unchanged — a zero
 * vector has no direction, and dividing by its magnitude would produce NaN.
 */
export const l2Normalise = (vector: Float32Array): Float32Array => {
  let sumOfSquares = 0;
  for (const component of vector) sumOfSquares += component * component;

  const magnitude = Math.sqrt(sumOfSquares);
  if (magnitude === 0) return vector;

  const normalised = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) normalised[i] = vector[i] / magnitude;
  return normalised;
};

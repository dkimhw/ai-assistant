import { createHash } from "node:crypto";

/**
 * The on-disk form of a set of embeddings, and the rules for trusting it.
 *
 * Vectors are packed as one base64 Float32 blob rather than JSON number arrays:
 * ~900 × 1536 floats written as JSON text is well over 10 MB and slow to parse,
 * while the packed form is a few megabytes and decodes with one `Buffer.from`.
 *
 * The header records what produced the file. Loading revalidates it against the
 * current corpus, because a stale artifact degrades relevance *silently* —
 * search keeps working and quietly returns the wrong thing.
 *
 * Server-only: uses `node:crypto` and `Buffer`.
 */

export type VectorArtifact = {
  model: string;
  dimensions: number;
  /**
   * Digest of the exact chunks that were embedded, ids included. Any corpus,
   * chunking, or id-scheme change moves it.
   */
  fingerprint: string;
  /** Ids parallel to the vectors, one per embedded text. */
  ids: string[];
  /** Base64 of `ids.length × dimensions` little-endian Float32s. */
  vectors: string;
};

/**
 * Digest of the embedded chunks. Deliberately covers the chunking policy and the
 * id scheme, not just the corpus.
 *
 * The ids are in here because they are the half that can go stale invisibly: a
 * change to how ids are formed leaves every text byte-identical, so a digest
 * over texts alone would keep accepting an artifact whose ids no longer resolve
 * to any document — search that works and returns nothing.
 */
export const fingerprintChunks = (opts: {
  chunks: Array<{ id: string; text: string }>;
}): string => {
  const hash = createHash("sha256");
  // Length-prefixed rather than separated, so nothing an id or a text could
  // contain can imitate a boundary: ["a", "b"] must not hash the same as
  // ["a b"], or a chunking change that merges adjacent chunks would go
  // undetected.
  for (const chunk of opts.chunks) {
    hash.update(`${chunk.id.length}:${chunk.id}${chunk.text.length}:${chunk.text}`);
  }
  return hash.digest("hex");
};

export const encodeVectors = (opts: { vectors: Float32Array[] }): string => {
  const dimensions = opts.vectors[0]?.length ?? 0;

  const packed = new Float32Array(opts.vectors.length * dimensions);
  opts.vectors.forEach((vector, index) => packed.set(vector, index * dimensions));

  return Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength).toString(
    "base64"
  );
};

export const decodeVectors = (opts: {
  vectors: string;
  dimensions: number;
}): Float32Array[] => {
  // Guard the loop below, which would never advance at 0.
  if (opts.dimensions <= 0) {
    throw new Error(`Cannot decode vectors of ${opts.dimensions} dimensions.`);
  }

  const bytes = Buffer.from(opts.vectors, "base64");

  // Buffer pools its allocations, so slice into an aligned copy before viewing
  // the memory as Float32 — Float32Array requires a 4-byte-aligned offset.
  const packed = new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  );

  const decoded: Float32Array[] = [];
  for (let start = 0; start < packed.length; start += opts.dimensions) {
    decoded.push(packed.subarray(start, start + opts.dimensions));
  }
  return decoded;
};

/**
 * Throws unless the artifact was built by the configured model, at the
 * configured dimensionality, from exactly the texts we are about to search.
 */
export const assertArtifactMatches = (opts: {
  artifact: VectorArtifact;
  model: string;
  dimensions: number;
  fingerprint: string;
  rebuildCommand: string;
}): void => {
  const { artifact, model, dimensions, fingerprint, rebuildCommand } = opts;

  const mismatch =
    artifact.model !== model
      ? `model "${artifact.model}", configured model is "${model}"`
      : artifact.dimensions !== dimensions
        ? `${artifact.dimensions} dimensions, configured dimensions are ${dimensions}`
        : artifact.fingerprint !== fingerprint
          ? `fingerprint ${artifact.fingerprint.slice(0, 12)}…, corpus is ${fingerprint.slice(0, 12)}…`
          : undefined;

  if (mismatch) {
    throw new Error(
      `Vector artifact is stale: it was built with ${mismatch}. Run \`${rebuildCommand}\`.`
    );
  }

  if (artifact.ids.length * dimensions * Float32Array.BYTES_PER_ELEMENT !==
      Buffer.from(artifact.vectors, "base64").byteLength) {
    throw new Error(
      `Vector artifact is corrupt: ${artifact.ids.length} ids do not match the packed vector length. Run \`${rebuildCommand}\`.`
    );
  }
};

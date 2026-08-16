import { createHash } from "node:crypto";

/**
 * The one place that knows how a document is named.
 *
 *   document id = `${sourceType}:${nativeId}`      // email:email_1759404204639_rcsddgue6
 *   chunk id    = `${documentId}#${n}`             // email:email_1759404204639_rcsddgue6#2
 *
 * Namespacing by source makes uniqueness structural rather than hoped for: two
 * sources may mint the same native id and still be two documents. It also means
 * any id answers "what kind of thing is this?" without a lookup.
 *
 * `:` and `#` are therefore reserved, and a native id containing either is
 * rejected at index time. The alternative — escaping — buys nothing here and
 * makes every id harder to grep against the corpus it came from.
 *
 * Parsing splits on the *first* `:` and the *last* `#`, so it is the exact
 * inverse of formatting for any native id this module accepts.
 *
 * Nothing outside the document layer and its adapters should build or take
 * apart an id by hand.
 *
 * Server-only: uses `node:crypto` for the hashed-id fallback.
 */

/** A short lowercase slug owned by an adapter: `email`. */
export type SourceType = string;

/** `${sourceType}:${nativeId}`. */
export type DocumentId = string;

const RESERVED = [":", "#"];

/**
 * Long enough that a collision across a corpus this size is not a thing that
 * happens, short enough to stay readable in a log line. 16 hex characters is
 * 64 bits.
 */
const HASH_CHARACTERS = 16;

export const formatDocumentId = (opts: {
  sourceType: SourceType;
  nativeId: string;
}): DocumentId => {
  const { sourceType, nativeId } = opts;

  if (nativeId.length === 0) {
    throw new Error(`Source "${sourceType}" produced a document with an empty id.`);
  }

  // A malformed id would not fail on its own — it would parse back into a
  // different id, miss every lookup, and drop the document from all results.
  const reserved = RESERVED.find((character) => nativeId.includes(character));
  if (reserved) {
    throw new Error(
      `Document id "${nativeId}" from source "${sourceType}" must not contain "${reserved}".`
    );
  }

  const badSourceType = RESERVED.find((character) => sourceType.includes(character));
  if (badSourceType) {
    throw new Error(
      `Source type "${sourceType}" must not contain "${badSourceType}".`
    );
  }

  return `${sourceType}:${nativeId}`;
};

export const parseDocumentId = (
  id: DocumentId
): { sourceType: SourceType; nativeId: string } => {
  const separator = id.indexOf(":");
  if (separator <= 0 || separator === id.length - 1) {
    throw new Error(
      `Document id "${id}" is not in the form \`sourceType:nativeId\`.`
    );
  }

  return {
    sourceType: id.slice(0, separator),
    nativeId: id.slice(separator + 1),
  };
};

export const formatChunkId = (opts: {
  documentId: DocumentId;
  index: number;
}): string => `${opts.documentId}#${opts.index}`;

/** `email:abc#2` -> `email:abc`. The inverse of {@link formatChunkId}. */
export const documentIdOfChunk = (chunkId: string): DocumentId => {
  const separator = chunkId.lastIndexOf("#");
  return separator === -1 ? chunkId : chunkId.slice(0, separator);
};

/**
 * A native id for a source that has none of its own — a text file dropped into a
 * folder, a scraped page — so it can join the corpus without a registry handing
 * out identifiers.
 *
 * Content-addressed ids are the fallback and not the rule: an id derived from
 * the text moves the moment the text is edited, which breaks any stored
 * reference to it. A source with stable ids of its own keeps them.
 */
export const hashNativeId = (opts: { text: string }): string =>
  createHash("sha256").update(opts.text).digest("hex").slice(0, HASH_CHARACTERS);

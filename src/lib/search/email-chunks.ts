import { formatChunkId } from "@/lib/search/document-id";

/**
 * Turning emails into the texts we embed. This is email-specific knowledge and
 * lives on the adapter side of the boundary — the semantic ranker sees vectors
 * and nothing else.
 *
 * Four decisions, in the order they are applied:
 *
 * 1. Strip quoted reply text. Every message in a thread quotes its history; left
 *    in, a thread collapses into one repeated vector and a single conversation
 *    crowds out every other answer.
 * 2. Prepend the subject. It carries thread context into the vector, mirroring
 *    the lexical index where `subject` already outweighs `body`.
 * 3. Leave addresses out. They are pure lexical signal, indexed and weighted by
 *    the ranker that handles identifiers well; embedding them only dilutes.
 * 4. Split long bodies, leave short ones whole. A single vector averaged over
 *    several unrelated topics is noise, but 531 of 547 emails here are under the
 *    threshold and need no help.
 */

export type EmailChunk = {
  /** `${documentId}#${n}` — unique per chunk, so the ranker can rank chunks. */
  id: string;
  text: string;
};

/**
 * Set from the corpus's character distribution (median 434, p90 730, max 6,660),
 * not from measured retrieval quality. 16 emails exceed it.
 */
const LONG_BODY_CHARS = 1500;
/** Target size of each chunk of a long body. */
const CHUNK_CHARS = 1200;

const QUOTE_MARKER = /^\s*>/;

/**
 * Lines from here down are quoted history, not this message.
 *
 * Conventions vary by client, so this is a heuristic: Gmail/Apple attribution
 * ("On <date>, <someone> wrote:"), Outlook's separator, and a bare forwarded
 * header block. A miss shows up as thread clustering in results.
 */
const ATTRIBUTION_MARKERS = [
  /^\s*On\b.{0,200}\bwrote:\s*$/i,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  // Only an actual header block, not a body line that happens to start "From:".
  /^\s*From:\s.*[<@].*$/i,
  /^\s*\[Original email quoted\]\s*$/i,
];

export const stripQuotedText = (body: string): string => {
  const lines = body.split("\n");

  const attributionAt = lines.findIndex((line) =>
    ATTRIBUTION_MARKERS.some((marker) => marker.test(line))
  );

  const own = (attributionAt === -1 ? lines : lines.slice(0, attributionAt))
    .filter((line) => !QUOTE_MARKER.test(line))
    // A trailing "---" separator is left over once the quote below it goes.
    .join("\n")
    .replace(/\n\s*-{2,}\s*$/, "");

  return own.trim();
};

/** Split on paragraph boundaries, keeping one paragraph of overlap for continuity. */
const splitIntoChunks = (text: string): string[] => {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;

  for (const paragraph of paragraphs) {
    if (length > 0 && length + paragraph.length > CHUNK_CHARS) {
      chunks.push(current.join("\n\n"));
      const overlap = current[current.length - 1];
      current = [overlap];
      length = overlap.length;
    }

    current.push(paragraph);
    length += paragraph.length;
  }

  if (current.length > 0) chunks.push(current.join("\n\n"));

  return chunks;
};

/**
 * `id` is the document id the chunks hang off — the document layer mints it and
 * `formatChunkId` derives the chunk ids from it, so the `#` convention is not
 * re-implemented here.
 */
export const chunkEmail = (opts: {
  email: { id: string; subject: string; body: string };
}): EmailChunk[] => {
  const { email } = opts;

  const body = stripQuotedText(email.body);
  const bodies = body.length > LONG_BODY_CHARS ? splitIntoChunks(body) : [body];

  return bodies.map((text, index) => ({
    id: formatChunkId({ documentId: email.id, index }),
    text: `${email.subject}\n\n${text}`.trim(),
  }));
};

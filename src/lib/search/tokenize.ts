/**
 * Corpus-agnostic tokenizer shared by the BM25 index and its queries.
 *
 * NFKC normalise -> lowercase -> split on non-alphanumerics -> drop
 * single-character tokens and stopwords. Email addresses additionally survive
 * whole, alongside their component words, so a query for either the full
 * address or just "david xu" hits.
 */

const STOPWORDS = new Set([
  "a",
  "about",
  "all",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "do",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "our",
  "she",
  "so",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "which",
  "who",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

const EMAIL_PATTERN = /[\w.+-]+@[\w.-]+\.\w+/gu;
const SEPARATOR_PATTERN = /[^\p{L}\p{N}]+/u;

const isKept = (token: string) => token.length > 1 && !STOPWORDS.has(token);

export const tokenize = (text: string): string[] => {
  const normalised = text.normalize("NFKC").toLowerCase();

  const raw: string[] = [];
  let cursor = 0;
  for (const match of normalised.matchAll(EMAIL_PATTERN)) {
    const address = match[0];
    raw.push(...normalised.slice(cursor, match.index).split(SEPARATOR_PATTERN));
    raw.push(address, ...address.split(SEPARATOR_PATTERN));
    cursor = match.index + address.length;
  }
  raw.push(...normalised.slice(cursor).split(SEPARATOR_PATTERN));

  return raw.filter(isKept);
};

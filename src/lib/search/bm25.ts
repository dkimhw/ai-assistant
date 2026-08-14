import { tokenize as defaultTokenize } from "@/lib/search/tokenize";

/**
 * Corpus-agnostic BM25F ranker. Knows nothing about emails — callers supply
 * documents as `{ id, fields }` and, optionally, per-field weights.
 *
 *   idf(t)  = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))          // Lucene variant
 *   tf~(t,d) = Σ_f w_f · tf(t, d.f) / (1 - b + b · len(d.f)/avgdl_f)
 *   score(d) = Σ_t idf(t) · tf~(t,d) · (k1 + 1) / (tf~(t,d) + k1)
 *
 * The weighted term frequency is accumulated across fields *before*
 * saturation, so a document matching weakly in many fields is not
 * over-rewarded.
 */

export type BM25Document = {
  id: string;
  fields: Record<string, string>;
};

export type BM25Options = {
  k1?: number;
  b?: number;
  fieldWeights?: Record<string, number>;
  tokenize?: (text: string) => string[];
};

type Posting = {
  doc: number;
  /** field name -> occurrences of the term in that field */
  tf: Record<string, number>;
};

export type BM25Index = {
  docIds: string[];
  fieldNames: string[];
  fieldLengths: Record<string, Float64Array>;
  avgFieldLength: Record<string, number>;
  postings: Map<string, Posting[]>;
  df: Map<string, number>;
  docCount: number;
  options: Required<BM25Options>;
};

export type BM25Result = {
  id: string;
  /** Unbounded positive, corpus-relative. Not a probability. */
  score: number;
  matchedTerms: string[];
};

const DEFAULT_K1 = 1.2;
const DEFAULT_B = 0.75;
const DEFAULT_LIMIT = 10;

export const buildBM25Index = (
  opts: { documents: BM25Document[] } & BM25Options
): BM25Index => {
  const {
    documents,
    k1 = DEFAULT_K1,
    b = DEFAULT_B,
    fieldWeights = {},
    tokenize = defaultTokenize,
  } = opts;

  const fieldNames = [
    ...new Set(documents.flatMap((document) => Object.keys(document.fields))),
  ];

  const docCount = documents.length;
  const docIds = documents.map((document) => document.id);
  const fieldLengths: Record<string, Float64Array> = {};
  for (const field of fieldNames) {
    fieldLengths[field] = new Float64Array(docCount);
  }

  const postings = new Map<string, Posting[]>();
  const df = new Map<string, number>();

  documents.forEach((document, doc) => {
    const termFields = new Map<string, Record<string, number>>();

    for (const field of fieldNames) {
      const tokens = tokenize(document.fields[field] ?? "");
      fieldLengths[field][doc] = tokens.length;

      for (const token of tokens) {
        let byField = termFields.get(token);
        if (!byField) {
          byField = {};
          termFields.set(token, byField);
        }
        byField[field] = (byField[field] ?? 0) + 1;
      }
    }

    for (const [term, tf] of termFields) {
      let list = postings.get(term);
      if (!list) {
        list = [];
        postings.set(term, list);
      }
      list.push({ doc, tf });
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  });

  const avgFieldLength: Record<string, number> = {};
  for (const field of fieldNames) {
    let total = 0;
    for (const length of fieldLengths[field]) total += length;
    avgFieldLength[field] = docCount === 0 ? 0 : total / docCount;
  }

  const resolvedWeights: Record<string, number> = {};
  for (const field of fieldNames) {
    resolvedWeights[field] = fieldWeights[field] ?? 1;
  }

  return {
    docIds,
    fieldNames,
    fieldLengths,
    avgFieldLength,
    postings,
    df,
    docCount,
    options: { k1, b, fieldWeights: resolvedWeights, tokenize },
  };
};

export const searchBM25 = (opts: {
  index: BM25Index;
  query: string;
  limit?: number;
  minScore?: number;
}): BM25Result[] => {
  const { index, query, limit = DEFAULT_LIMIT, minScore = 0 } = opts;
  const { k1, b, fieldWeights, tokenize } = index.options;

  // Repeated words in a short query should not double their own weight.
  const terms = [...new Set(tokenize(query))];

  const scores = new Map<number, number>();
  const matched = new Map<number, string[]>();

  for (const term of terms) {
    const list = index.postings.get(term);
    if (!list) continue; // absent terms contribute 0 and are not "matched"

    const df = index.df.get(term) ?? 0;
    const idf = Math.log(1 + (index.docCount - df + 0.5) / (df + 0.5));

    for (const posting of list) {
      let weightedTf = 0;
      for (const [field, tf] of Object.entries(posting.tf)) {
        const avg = index.avgFieldLength[field];
        // avg can only be 0 when the field is empty everywhere, in which case
        // there is no posting for it — guard anyway so no NaN can escape.
        const normaliser =
          avg === 0
            ? 1
            : 1 - b + (b * index.fieldLengths[field][posting.doc]) / avg;
        weightedTf += (fieldWeights[field] * tf) / normaliser;
      }

      const contribution = (idf * (weightedTf * (k1 + 1))) / (weightedTf + k1);
      scores.set(posting.doc, (scores.get(posting.doc) ?? 0) + contribution);

      const terms = matched.get(posting.doc);
      if (terms) terms.push(term);
      else matched.set(posting.doc, [term]);
    }
  }

  return [...scores.entries()]
    .filter(([, score]) => score > minScore)
    .sort(([docA, scoreA], [docB, scoreB]) =>
      scoreB === scoreA ? docA - docB : scoreB - scoreA
    )
    .slice(0, limit)
    .map(([doc, score]) => ({
      id: index.docIds[doc],
      score,
      matchedTerms: matched.get(doc) ?? [],
    }));
};

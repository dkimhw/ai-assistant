import { buildBM25Index, searchBM25, type BM25Index } from "@/lib/search/bm25";
import {
  documentIdOfChunk,
  formatDocumentId,
  hashNativeId,
  parseDocumentId,
  type DocumentId,
  type SourceType,
} from "@/lib/search/document-id";
import { createOpenAIEmbedder, type Embedder } from "@/lib/search/embedder";
import { fuseRRF } from "@/lib/search/rrf";
import type { RerankCandidate, Reranker } from "@/lib/search/reranker";
import {
  buildSemanticIndex,
  searchSemantic,
  type SemanticIndex,
} from "@/lib/search/semantic";
import { emailSource } from "@/lib/search/emails";

/**
 * The document layer: the registry of sources, and the one public entry point
 * that ranks across all of them.
 *
 * Below it sit three corpus-agnostic rankers — BM25F for words, cosine
 * similarity for meaning, Reciprocal Rank Fusion to join them. Above it sit
 * *source adapters*, each of which knows one kind of thing: where its documents
 * come from, which fields it indexes and how heavily, how it chunks text for
 * embedding, and where its vectors live. Email is the first such adapter, not
 * the thing search is built around.
 *
 * Adding a second kind of document is: write a `DocumentSource`, register it,
 * rebuild the vectors. No ranking, chunking, or fusion code moves.
 *
 * This layer never inspects a document's content. It mints ids, unions the
 * sources into one index of each kind, and collapses the results back to
 * documents.
 *
 * Server-only: the registered sources read `data/*.json` from disk.
 */

export type { DocumentId, SourceType };

/** A chunk of a document: the unit that gets embedded and semantically ranked. */
export type DocumentChunk = {
  /** `${documentId}#${n}`. */
  id: string;
  text: string;
};

/** What a source hands over. The id is minted by this layer, not by the source. */
export type SourceDocument = {
  /**
   * The source's own stable identifier. Omitted only by a source that declares
   * `hasNativeIds: false`, whose ids are hashed from `chunkText` instead.
   */
  nativeId?: string;
  /** What BM25F indexes, keyed by field name. */
  fields: Record<string, string>;
  /** What gets embedded, before the source's chunking policy is applied. */
  chunkText: string;
};

export type SearchDocument = SourceDocument & {
  id: DocumentId;
  sourceType: SourceType;
};

export type DocumentSource = {
  /** A short lowercase slug, unique across the registry. Namespaces every id. */
  sourceType: SourceType;
  /**
   * This source's property — weights are tuned where the fields are chosen.
   *
   * Known limitation, harmless while email is the only source: the BM25F index
   * is one index, so field *length statistics* are pooled across sources even
   * though the weights are per source. Registering a source with no `subject`
   * would push a mass of zero-length subjects into `avgFieldLength.subject` and
   * quietly demote subject matches for email. Settle it when a real second
   * source lands — either per-source length normalisation in `bm25.ts` or
   * source-namespaced field names.
   */
  fieldWeights: Record<string, number>;
  /**
   * Whether `all()` supplies `nativeId`. A source that does not gets a content
   * hash instead, so a folder of loose text files can be indexed without a
   * registry handing out identifiers. Defaults to true.
   */
  hasNativeIds?: boolean;
  all: () => SourceDocument[];
  /** The source's chunking policy. Ids must come from `formatChunkId`. */
  chunk: (opts: { document: SearchDocument }) => DocumentChunk[];
  /**
   * Vectors for the chunks just produced, aligned by id. A source with no
   * embeddings omits this and is ranked lexically only.
   */
  vectors?: (opts: { chunks: DocumentChunk[] }) => Array<{
    id: string;
    vector: Float32Array;
  }>;
};

/**
 * A chunk, plus where it sits among its document's chunks.
 *
 * The position is here because a passage from the middle of a document is not
 * the document, and a caller showing one to a model has to be able to say so.
 * Without it, an excerpt reads as a complete document that simply does not
 * mention what was asked about.
 */
export type RankedChunk = DocumentChunk & {
  /** 0-based. */
  index: number;
  /** How many chunks the document has in total; 1 means the chunk is the document. */
  count: number;
};

export type DocumentResult = {
  document: SearchDocument;
  /** A fused RRF score: an ordering signal with no absolute meaning. */
  score: number;
  /**
   * The chunk this document was ranked on — present only when a reranker ran.
   * It is what a caller should show a model in place of the document's opening,
   * because on a long document the passage that matched is often not the start.
   *
   * The rerank score itself is deliberately absent. It has no meaning outside
   * its own call, and the ordering already encodes everything it says.
   */
  chunk?: RankedChunk;
};

/**
 * The registered sources. Email is the only real one; a second kind of document
 * joins by being added here.
 *
 * Resolved on first use rather than at module scope: an adapter imports this
 * module for its types and for `searchDocuments`, and reading `emailSource`
 * during evaluation would make that cycle depend on which module loaded first.
 * Memoised because `getCorpus` keys its cache on the array's identity.
 */
let cachedRegistry: DocumentSource[] | undefined;

const registry = (): DocumentSource[] => (cachedRegistry ??= [emailSource]);

/**
 * A cosine floor, so a query about nothing in the corpus returns nothing rather
 * than a page of nearest-but-unrelated guesses. Unrelated text pairs sit well
 * below this under `text-embedding-3-small`; a reasoned starting point.
 */
const SEMANTIC_MIN_SCORE = 0.3;

/**
 * Each ranker is asked for more candidates than the caller wants, so fusion has
 * material to work with rather than two lists that barely overlap.
 */
const CANDIDATE_POOL_MULTIPLIER = 4;
const MIN_CANDIDATE_POOL = 40;

/**
 * The semantic pool is capped regardless of the requested limit. The search page
 * asks for the whole corpus so it can paginate, and without this cap that turns
 * the semantic leg into "every document above the floor" — which puts a long
 * tail of loosely-related documents into the result count. Lexical matches stay
 * uncapped because a term match is evidence; a cosine of 0.31 is barely a hint.
 */
const MAX_SEMANTIC_POOL = 50;

/**
 * How many fused documents a reranker is shown, before the caller's limit is
 * applied. Deep enough that reranking has real material to reorder rather than
 * being handed the same five it would have returned; shallow enough that one
 * model call reads a bounded amount of text.
 *
 * A starting position to tune against evals, not a claim — and the first knob
 * worth tuning, because it bounds what reranking can possibly fix.
 *
 * A floor rather than a ceiling when a caller asks for more results than this:
 * a pool shallower than the limit could not fill it. `RERANK_MAX_CANDIDATES` is
 * what actually bounds the size of the call.
 */
export const RERANK_CANDIDATE_POOL = 25;

/**
 * The hard bound on how many passages one rerank call reads, whatever the pool
 * works out to. The pool counts documents; this counts the chunks they produce,
 * which is what the model actually pays for — a source chunking finely, or a
 * caller asking for a large limit, would otherwise send an unbounded prompt.
 *
 * Sized to sit just above the pool, since email averages 1.1 chunks per
 * document: it is a backstop, not a working limit. Another starting position.
 */
export const RERANK_MAX_CANDIDATES = 50;

const DEFAULT_LIMIT = 10;

type Corpus = {
  byId: Map<DocumentId, SearchDocument>;
  /** Which source owns a document — how a result gets back to its chunks. */
  sourceByType: Map<SourceType, DocumentSource>;
  index: BM25Index;
  /**
   * Built on first *semantic* use, not with the rest of the corpus: it reads and
   * decodes every source's vector artifact, and a caller that only wants to look
   * a document up by id should neither pay for that nor be thrown a staleness
   * error by it.
   */
  semanticIndex: () => SemanticIndex;
  sourceTypes: SourceType[];
};

const documentsOf = (source: DocumentSource): SearchDocument[] => {
  const hasNativeIds = source.hasNativeIds ?? true;
  const seenIds = new Set<DocumentId>();

  return source.all().map((document) => {
    if (hasNativeIds && document.nativeId === undefined) {
      throw new Error(
        `Source "${source.sourceType}" declares native ids but supplied a document without one.`
      );
    }

    const nativeId = hasNativeIds
      ? (document.nativeId as string)
      : hashNativeId({ text: document.chunkText });

    const id = formatDocumentId({ sourceType: source.sourceType, nativeId });

    // Within a source, two documents sharing an id is the same silent shadowing
    // namespacing exists to prevent: the by-id map keeps the last one, so a hit
    // on the first resolves to the wrong content and the first is unreachable.
    // Byte-identical documents are not hypothetical here — 143 of this email
    // corpus's 606 chunks are exact duplicates — so a hashed-id source will meet
    // this, and should be told rather than quietly losing a document.
    if (seenIds.has(id)) {
      throw new Error(
        `Source "${source.sourceType}" produced two documents with the id "${id}".${
          hasNativeIds
            ? ""
            : " Ids are hashed from `chunkText` for this source, so its documents must be distinct."
        }`
      );
    }
    seenIds.add(id);

    return {
      ...document,
      id,
      sourceType: source.sourceType,
    };
  });
};

/**
 * Every chunk a source produces, ids and all. Exported so the build script
 * embeds exactly the chunks the query path will look up — the artifact and the
 * runtime index cannot drift apart on ids.
 */
export const chunksOfSource = (opts: {
  source: DocumentSource;
}): DocumentChunk[] =>
  documentsOf(opts.source).flatMap((document) =>
    opts.source.chunk({ document })
  );

/**
 * One BM25F index over every source's documents. Field weights are unioned, so
 * each source keeps its own — two sources naming the same field must agree on
 * what it is worth, because the index has a single weight per field name.
 */
const fieldWeightsOf = (sources: DocumentSource[]): Record<string, number> => {
  const weights: Record<string, number> = {};

  for (const source of sources) {
    for (const [field, weight] of Object.entries(source.fieldWeights)) {
      if (weights[field] !== undefined && weights[field] !== weight) {
        throw new Error(
          `Sources disagree on the weight of field "${field}": ${weights[field]} and ${weight}. Rename the field or agree on a weight.`
        );
      }
      weights[field] = weight;
    }
  }

  return weights;
};

/**
 * The semantic index over every source that has vectors.
 *
 * Chunks whose text is byte-identical to an earlier chunk *of the same source*
 * are left out. 143 of this email corpus's 606 chunks are exact duplicates —
 * automated notifications like "Your monthly statement is ready", 16 of them
 * identical. Indexed individually they hold identical vectors, so they take the
 * top 16 semantic slots as a block and crowd every unique document off the page.
 * Ranking one representative is not a display choice: identical text should get
 * one vote, not sixteen. The duplicates stay fully findable through BM25, which
 * scores them on their own terms.
 *
 * Deduplication is per source rather than global: the same sentence arriving
 * from two kinds of document is two documents, not a repeat.
 */
const semanticDocumentsOf = (opts: {
  source: DocumentSource;
  documents: SearchDocument[];
}) => {
  const { source, documents } = opts;
  if (!source.vectors) return [];

  const chunks = documents.flatMap((document) => source.chunk({ document }));
  const textById = new Map(chunks.map((chunk) => [chunk.id, chunk.text]));

  const seenTexts = new Set<string>();
  return source.vectors({ chunks }).flatMap((entry) => {
    const text = textById.get(entry.id);

    // A vector for a chunk that does not exist means the artifact and the
    // chunking policy have diverged. Skipping it would give exactly the failure
    // the fingerprint exists to prevent: search that ranks correctly over the
    // wrong half of the corpus and quietly returns less than it should.
    if (text === undefined) {
      throw new Error(
        `Source "${source.sourceType}" supplied a vector for unknown chunk "${entry.id}".`
      );
    }

    if (seenTexts.has(text)) return [];
    seenTexts.add(text);
    return [entry];
  });
};

const buildCorpus = (sources: DocumentSource[]): Corpus => {
  const perSource = sources.map((source) => ({
    source,
    documents: documentsOf(source),
  }));

  const documents = perSource.flatMap((entry) => entry.documents);

  let cachedSemanticIndex: SemanticIndex | undefined;

  return {
    byId: new Map(documents.map((document) => [document.id, document])),
    sourceByType: new Map(
      sources.map((source) => [source.sourceType, source] as const)
    ),
    index: buildBM25Index({
      documents: documents.map((document) => ({
        id: document.id,
        fields: document.fields,
      })),
      fieldWeights: fieldWeightsOf(sources),
    }),
    semanticIndex: () =>
      (cachedSemanticIndex ??= buildSemanticIndex({
        documents: perSource.flatMap(semanticDocumentsOf),
      })),
    sourceTypes: sources.map((source) => source.sourceType),
  };
};

/**
 * Memoised per set of sources — the registry is indexed once for the process
 * lifetime, and a test's injected sources are indexed once per array it passes.
 * Keyed by array identity, which is what makes the registry's entry stable.
 */
const corpusCache = new WeakMap<DocumentSource[], Corpus>();

const getCorpus = (sources: DocumentSource[]): Corpus => {
  const cached = corpusCache.get(sources);
  if (cached) return cached;

  const corpus = buildCorpus(sources);
  corpusCache.set(sources, corpus);
  return corpus;
};

/**
 * Rank documents by meaning. Chunks are collapsed to their parent document, each
 * document taking its best-scoring chunk, so this returns documents rather than
 * fragments.
 *
 * Takes the index rather than fetching it, so that a stale or missing artifact
 * throws at the call site instead of being caught by the embedder's fallback.
 */
const semanticDocumentIds = async (opts: {
  query: string;
  embedder: Embedder;
  index: SemanticIndex;
  limit: number;
}): Promise<DocumentId[]> => {
  const [queryVector] = await opts.embedder.embed({ texts: [opts.query] });

  const chunkResults = searchSemantic({
    index: opts.index,
    queryVector,
    // Ask for more chunks than documents wanted: several may share a document.
    limit: opts.limit * 3,
    minScore: SEMANTIC_MIN_SCORE,
  });

  const best = new Set<DocumentId>();
  for (const result of chunkResults) best.add(documentIdOfChunk(result.id));
  return [...best].slice(0, opts.limit);
};

/**
 * Reorder fused results by reading their text.
 *
 * This stage lives here rather than in a caller because this is where chunk ids
 * and chunk text already exist: a caller doing it would have to re-derive a
 * source's chunking policy, which is precisely the knowledge the adapter
 * boundary keeps in one place.
 *
 * Chunks are reranked and then collapsed to documents, each taking its best
 * chunk — the same collapse the semantic leg performs. That is the point on a
 * long document: it is relevant because one of its paragraphs answers the
 * question, not on average.
 *
 * Anything the reranker leaves out keeps its fused position at the end of the
 * list, so a partial answer costs ordering rather than recall.
 */
const rerankResults = async (opts: {
  query: string;
  context?: string[];
  reranker: Reranker;
  corpus: Corpus;
  results: DocumentResult[];
  limit: number;
}): Promise<DocumentResult[]> => {
  const rankedById = new Map<string, RankedChunk>();
  const firstChunkOf = new Map<DocumentId, RankedChunk>();
  const candidates: RerankCandidate[] = [];

  for (const result of opts.results) {
    const source = opts.corpus.sourceByType.get(result.document.sourceType);
    if (!source) continue;

    const chunks = source.chunk({ document: result.document });

    chunks.forEach((chunk, index) => {
      const ranked = { ...chunk, index, count: chunks.length };
      rankedById.set(chunk.id, ranked);
      if (index === 0) firstChunkOf.set(result.document.id, ranked);
      candidates.push({ id: chunk.id, text: chunk.text });
    });

    // The pool bounds *documents*; this bounds the text one model call reads,
    // which is the thing that actually costs money and context. They coincide
    // for email at 1.1 chunks per document, but a source that split a long
    // document into thirty pieces would blow past the pool's intent otherwise.
    if (candidates.length >= RERANK_MAX_CANDIDATES) break;
  }

  candidates.length = Math.min(candidates.length, RERANK_MAX_CANDIDATES);

  const orderedChunkIds = await opts.reranker.rerank({
    query: opts.query,
    context: opts.context,
    candidates,
  });

  const resultsByDocument = new Map(
    opts.results.map((result) => [result.document.id, result] as const)
  );

  const reranked: DocumentResult[] = [];
  const taken = new Set<DocumentId>();

  for (const chunkId of orderedChunkIds) {
    const documentId = documentIdOfChunk(chunkId);
    if (taken.has(documentId)) continue;

    const result = resultsByDocument.get(documentId);
    if (!result) continue;

    taken.add(documentId);
    reranked.push({ ...result, chunk: rankedById.get(chunkId) });

    if (reranked.length >= opts.limit) return reranked;
  }

  // Whatever the reranker did not mention, in the order fusion left it. Its
  // first chunk stands in for a winner it was never given: that is the opening
  // of the document, which is what a caller would have shown anyway.
  for (const result of opts.results) {
    if (reranked.length >= opts.limit) break;
    if (taken.has(result.document.id)) continue;

    reranked.push({ ...result, chunk: firstChunkOf.get(result.document.id) });
  }

  return reranked;
};

/**
 * Hybrid search across every registered source.
 *
 * The returned score is a fused RRF score. Like the BM25 score it replaced, it
 * is an ordering signal with no absolute meaning.
 *
 * If the embedder is unavailable or the embedding call fails, the semantic leg
 * is dropped and results are lexical-only: an outage degrades quality rather
 * than breaking the page. Fusion still runs, over a single ranking, which
 * preserves the lexical order exactly.
 *
 * A stale or missing vector artifact is *not* covered by that fallback and
 * throws. A provider outage is transient and outside our control; a stale
 * artifact is a build step somebody forgot, and quietly serving worse results
 * for it is exactly the silent degradation the fingerprint exists to prevent.
 *
 * Passing a `reranker` adds a stage after fusion: a deeper pool of candidates is
 * read and reordered, and each result gains the chunk it won on. It is off
 * unless asked for, so a caller pays for a model call only by requesting one —
 * the search page does not, the chat tool does. A reranker that fails degrades
 * the same way the embedder does: log, and return the fused ordering.
 */
export const searchDocuments = async (opts: {
  query: string;
  limit?: number;
  /**
   * Off unless passed. Injectable for the same reason `embedder` is: tests use a
   * fake and never hit the network.
   */
  reranker?: Reranker;
  /**
   * Recent conversation, oldest first, passed to the reranker so a follow-up is
   * judged against what was being discussed. Ignored without a reranker; the
   * lexical and semantic legs deliberately see only the query.
   */
  rerankContext?: string[];
  /** Defaults to the registry. Injectable for the same reason `embedder` is. */
  sources?: DocumentSource[];
  /**
   * Restrict results to these source types. Applied to each ranking *before*
   * the limit, so a caller wanting five emails gets five emails rather than
   * whatever survives truncating a mixed list.
   */
  sourceTypes?: SourceType[];
  /** Defaults to the configured OpenAI embedder. Tests inject a stub and never hit the network. */
  embedder?: Embedder;
}): Promise<DocumentResult[]> => {
  // Nothing to rank, and nothing worth an embedding round-trip.
  if (opts.query.trim().length === 0) return [];

  const limit = opts.limit ?? DEFAULT_LIMIT;

  // Outside the try below on purpose — see the note above about staleness.
  const corpus = getCorpus(opts.sources ?? registry());

  const wanted = opts.sourceTypes;
  // Filtering the candidate pool rather than the corpus: a narrow filter over a
  // fixed pool can still under-fill, which is a relevance cost and not a
  // correctness one. Worth revisiting when a real second source lands and the
  // pool sizes can be tuned against it.
  const ofWantedSource = (id: DocumentId) =>
    wanted === undefined || wanted.includes(parseDocumentId(id).sourceType);

  const poolSize = Math.max(MIN_CANDIDATE_POOL, limit * CANDIDATE_POOL_MULTIPLIER);

  const lexicalIds = searchBM25({
    index: corpus.index,
    query: opts.query,
    limit: poolSize,
  })
    .map((result) => result.id)
    .filter(ofWantedSource);

  const semanticIndex = corpus.semanticIndex();

  let semanticIds: DocumentId[] = [];
  try {
    // No point embedding the query when no source has vectors: the ranking
    // would come back empty having paid for a round-trip, and with no API key
    // configured it would warn on every search.
    if (semanticIndex.ids.length > 0) {
      semanticIds = (
        await semanticDocumentIds({
          query: opts.query,
          embedder: opts.embedder ?? createOpenAIEmbedder(),
          index: semanticIndex,
          limit: Math.min(poolSize, MAX_SEMANTIC_POOL),
        })
      ).filter(ofWantedSource);
    }
  } catch (error) {
    // Deliberate degradation, not an accident: log and rank lexically.
    console.warn(
      "[search] semantic ranking unavailable, falling back to lexical only:",
      error instanceof Error ? error.message : error
    );
  }

  // Reranking reads a deeper pool than the caller asked for, then cuts back to
  // the limit — otherwise it would be handed exactly the results it is meant to
  // be able to improve on.
  const fusedLimit = opts.reranker
    ? Math.max(limit, RERANK_CANDIDATE_POOL)
    : limit;

  const fused = fuseRRF({
    rankings: [lexicalIds, semanticIds],
    limit: fusedLimit,
  }).flatMap((result) => {
    const document = corpus.byId.get(result.id);
    return document ? [{ document, score: result.score }] : [];
  });

  if (!opts.reranker) return fused;

  try {
    return await rerankResults({
      query: opts.query,
      context: opts.rerankContext,
      reranker: opts.reranker,
      corpus,
      results: fused,
      limit,
    });
  } catch (error) {
    // Deliberate degradation, as with the embedder: an outage costs relevance,
    // not the feature.
    console.warn(
      "[search] reranking unavailable, falling back to the fused ordering:",
      error instanceof Error ? error.message : error
    );
    return fused.slice(0, limit);
  }
};

/**
 * The document behind an id, routed to the source that owns it — so fetching a
 * result's full content does not require the caller to know where it came from.
 * Returns undefined for an id the owning source no longer has.
 */
export const getDocument = (opts: {
  id: DocumentId;
  sources?: DocumentSource[];
}): SearchDocument | undefined => {
  const sources = opts.sources ?? registry();
  const { sourceType } = parseDocumentId(opts.id);

  const corpus = getCorpus(sources);
  if (!corpus.sourceTypes.includes(sourceType)) {
    throw new Error(
      `Unknown source type "${sourceType}" in document id "${opts.id}". Registered sources: ${corpus.sourceTypes.join(", ") || "none"}.`
    );
  }

  return corpus.byId.get(opts.id);
};

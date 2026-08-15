import fs from "node:fs";
import path from "node:path";
import { buildBM25Index, searchBM25, type BM25Index } from "@/lib/search/bm25";
import { chunkEmails } from "@/lib/search/email-chunks";
import {
  createOpenAIEmbedder,
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  type Embedder,
} from "@/lib/search/embedder";
import { fuseRRF } from "@/lib/search/rrf";
import {
  buildSemanticIndex,
  searchSemantic,
  type SemanticIndex,
} from "@/lib/search/semantic";
import {
  assertArtifactMatches,
  decodeVectors,
  fingerprintTexts,
  type VectorArtifact,
} from "@/lib/search/vector-artifact";

/**
 * Email adapter over two corpus-agnostic rankers: BM25F for words, cosine
 * similarity for meaning, joined by Reciprocal Rank Fusion.
 *
 * All email-specific knowledge lives here and in `email-chunks.ts` — the
 * rankers see fields and vectors and nothing else.
 *
 * Server-only: reads `data/*.json` from disk. Do not import from a client
 * component.
 */

export type Email = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  timestamp: string;
  arcId: string;
  phaseId: number;
};

/** A starting guess to tune against evals, not a claim. */
const EMAIL_FIELD_WEIGHTS = { subject: 3, body: 1, from: 2, to: 1 };

/**
 * A cosine floor, so a query about nothing in the corpus returns nothing rather
 * than a page of nearest-but-unrelated guesses. Unrelated text pairs sit well
 * below this under `text-embedding-3-small`; another reasoned starting point.
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
 * the semantic leg into "every email above the floor" — which puts a long tail of
 * loosely-related emails into the result count. Lexical matches stay uncapped
 * because a term match is evidence; a cosine of 0.31 is barely a hint.
 */
const MAX_SEMANTIC_POOL = 50;

const DEFAULT_LIMIT = 10;

const REBUILD_COMMAND = "pnpm run build:vectors";

const EMAILS_PATH = path.join(process.cwd(), "data", "emails.json");
const VECTORS_PATH = path.join(process.cwd(), "data", "email-vectors.json");

let cachedEmails: Email[] | undefined;
let cachedEmailsById: Map<string, Email> | undefined;
let cachedIndex: BM25Index | undefined;
let cachedSemanticIndex: SemanticIndex | undefined;

/** The whole corpus, read from disk once. Server-only. */
export const getAllEmails = (): Email[] => {
  cachedEmails ??= JSON.parse(fs.readFileSync(EMAILS_PATH, "utf-8")) as Email[];
  return cachedEmails;
};

const emailsById = (): Map<string, Email> => {
  cachedEmailsById ??= new Map(getAllEmails().map((email) => [email.id, email]));
  return cachedEmailsById;
};

/** Memoised module singleton — the corpus is read and indexed once. */
export const getEmailIndex = (): BM25Index => {
  cachedIndex ??= buildBM25Index({
    documents: getAllEmails().map((email) => ({
      id: email.id,
      fields: {
        subject: email.subject,
        body: email.body,
        from: email.from,
        to: email.to,
      },
    })),
    fieldWeights: EMAIL_FIELD_WEIGHTS,
  });
  return cachedIndex;
};

/**
 * Memoised module singleton over the committed vector artifact. Ids are chunk
 * ids, not email ids — collapsing chunks back to their email happens at query
 * time, where the scores are.
 *
 * Throws if the artifact does not match the corpus it is being searched
 * alongside: stale vectors degrade relevance silently, which is worse than a
 * loud failure at startup.
 *
 * Chunks whose text is byte-identical to an earlier chunk are left out of the
 * index. 143 of this corpus's 606 chunks are exact duplicates — automated
 * notifications like "Your monthly statement is ready", 16 of them identical.
 * Indexed individually they hold identical vectors, so they take the top 16
 * semantic slots as a block and crowd every unique email off the page. Ranking
 * one representative is not a display choice: identical text should get one
 * vote, not sixteen. The duplicates stay fully findable through BM25, which
 * scores them on their own terms.
 */
export const getEmailSemanticIndex = (): SemanticIndex => {
  if (cachedSemanticIndex) return cachedSemanticIndex;

  const chunks = chunkEmails({ emails: getAllEmails() });

  const artifact = JSON.parse(
    fs.readFileSync(VECTORS_PATH, "utf-8")
  ) as VectorArtifact;

  assertArtifactMatches({
    artifact,
    model: DEFAULT_EMBEDDING_MODEL,
    dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    fingerprint: fingerprintTexts({ texts: chunks.map((chunk) => chunk.text) }),
    rebuildCommand: REBUILD_COMMAND,
  });

  const vectors = decodeVectors({
    vectors: artifact.vectors,
    dimensions: artifact.dimensions,
  });

  // The fingerprint check above guarantees `chunks` and `artifact.ids` describe
  // the same texts in the same order, so indexing by position is safe here.
  const seenTexts = new Set<string>();
  const documents = artifact.ids.flatMap((id, index) => {
    const text = chunks[index].text;
    if (seenTexts.has(text)) return [];
    seenTexts.add(text);
    return [{ id, vector: vectors[index] }];
  });

  cachedSemanticIndex = buildSemanticIndex({ documents });
  return cachedSemanticIndex;
};

/** `emailId#3` -> `emailId`. */
const emailIdOf = (chunkId: string) => chunkId.split("#")[0];

/**
 * Rank emails by meaning. Chunks are collapsed to their parent email, each
 * email taking its best-scoring chunk, so this returns emails rather than
 * fragments.
 *
 * Takes the index rather than fetching it, so that a stale or missing artifact
 * throws at the call site instead of being caught by the embedder's fallback.
 */
const semanticEmailIds = async (opts: {
  query: string;
  embedder: Embedder;
  index: SemanticIndex;
  limit: number;
}): Promise<string[]> => {
  const [queryVector] = await opts.embedder.embed({ texts: [opts.query] });

  const chunkResults = searchSemantic({
    index: opts.index,
    queryVector,
    // Ask for more chunks than emails wanted: several may share one email.
    limit: opts.limit * 3,
    minScore: SEMANTIC_MIN_SCORE,
  });

  const bestPerEmail = new Set<string>();
  for (const result of chunkResults) bestPerEmail.add(emailIdOf(result.id));
  return [...bestPerEmail].slice(0, opts.limit);
};

/**
 * Hybrid search over the corpus.
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
 */
export const searchEmails = async (opts: {
  query: string;
  limit?: number;
  /** Defaults to the configured OpenAI embedder. Tests inject a stub and never hit the network. */
  embedder?: Embedder;
}): Promise<Array<{ email: Email; score: number }>> => {
  // Nothing to rank, and nothing worth an embedding round-trip.
  if (opts.query.trim().length === 0) return [];

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const byId = emailsById();

  const poolSize = Math.max(MIN_CANDIDATE_POOL, limit * CANDIDATE_POOL_MULTIPLIER);

  const lexicalIds = searchBM25({
    index: getEmailIndex(),
    query: opts.query,
    limit: poolSize,
  }).map((result) => result.id);

  // Outside the try on purpose — see the note above about staleness.
  const semanticIndex = getEmailSemanticIndex();

  let semanticIds: string[] = [];
  try {
    semanticIds = await semanticEmailIds({
      query: opts.query,
      embedder: opts.embedder ?? createOpenAIEmbedder(),
      index: semanticIndex,
      limit: Math.min(poolSize, MAX_SEMANTIC_POOL),
    });
  } catch (error) {
    // Deliberate degradation, not an accident: log and rank lexically.
    console.warn(
      "[search] semantic ranking unavailable, falling back to lexical only:",
      error instanceof Error ? error.message : error
    );
  }

  return fuseRRF({ rankings: [lexicalIds, semanticIds], limit }).flatMap(
    (result) => {
      const email = byId.get(result.id);
      return email ? [{ email, score: result.score }] : [];
    }
  );
};

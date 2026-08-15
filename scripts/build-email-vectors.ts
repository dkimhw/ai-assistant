import fs from "node:fs";
import path from "node:path";
import { chunksOfSource } from "../src/lib/search/documents";
import {
  createOpenAIEmbedder,
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  type Embedder,
} from "../src/lib/search/embedder";
import {
  encodeVectors,
  fingerprintChunks,
  type VectorArtifact,
} from "../src/lib/search/vector-artifact";
import { emailSource, getAllEmails } from "../src/lib/search/emails";

/**
 * Builds the committed vector artifacts. One command, run after any change to
 * the corpus or the chunking policy:
 *
 *   pnpm run build:vectors
 *
 * Writes two files:
 *   data/email-vectors.json  — one vector per email chunk, the semantic index
 *   data/query-vectors.json  — real embeddings of the queries used by the test
 *                              suite, so tests get true semantic neighbourhoods
 *                              with no network and no API key
 *
 * Relative imports rather than `@/`: this runs under tsx, outside Next's module
 * resolution.
 */

/**
 * Queries the test suite embeds. Each one is a real embedding of the exact
 * string, so `emails.test.ts` exercises genuine semantic retrieval offline.
 * Adding a test query means adding it here and re-running the build.
 */
const TEST_QUERIES = [
  "when do I need to hand over the remaining money before I can pick up the keys",
  "what paperwork proves how much I earn",
  "somewhere to hold the reception",
  "david.xu@firsthomemortgages.co.uk",
  "mortgage pre-approval",
  "zzzzqqqxyzzy",
];

const DATA_DIR = path.join(process.cwd(), "data");
const VECTORS_PATH = path.join(DATA_DIR, "email-vectors.json");
const QUERY_VECTORS_PATH = path.join(DATA_DIR, "query-vectors.json");

/** OpenAI accepts 2048 inputs per call; smaller batches keep request bodies sane. */
const BATCH_SIZE = 128;

const embedInBatches = async (opts: {
  embedder: Embedder;
  texts: string[];
}): Promise<Float32Array[]> => {
  const vectors: Float32Array[] = [];

  for (let start = 0; start < opts.texts.length; start += BATCH_SIZE) {
    const batch = opts.texts.slice(start, start + BATCH_SIZE);
    vectors.push(...(await opts.embedder.embed({ texts: batch })));
    process.stdout.write(
      `  embedded ${vectors.length}/${opts.texts.length}\r`
    );
  }
  process.stdout.write("\n");

  return vectors;
};

const writeArtifact = (opts: { at: string; artifact: VectorArtifact }) => {
  fs.writeFileSync(opts.at, JSON.stringify(opts.artifact));
  const megabytes = fs.statSync(opts.at).size / 1_000_000;
  console.log(
    `  wrote ${path.relative(process.cwd(), opts.at)} (${megabytes.toFixed(2)} MB)`
  );
};

const main = async () => {
  // Throws with an actionable message when no key is configured. There is no
  // meaningful partial success here, so failing immediately is the whole policy.
  const embedder = createOpenAIEmbedder({
    model: DEFAULT_EMBEDDING_MODEL,
    dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
  });

  const emails = getAllEmails();
  const chunks = chunksOfSource({ source: emailSource });
  const texts = chunks.map((chunk) => chunk.text);

  const characters = texts.reduce((total, text) => total + text.length, 0);
  console.log(
    [
      `model      ${embedder.model} @ ${embedder.dimensions}d`,
      `emails     ${emails.length}`,
      `chunks     ${chunks.length} (${chunks.length - emails.length} from splitting long bodies)`,
      `tokens     ~${Math.round(characters / 4).toLocaleString()} (≈ ${(characters / 4 / 1000).toFixed(0)}k, one-off)`,
    ].join("\n")
  );

  console.log("\nembedding the corpus…");
  const vectors = await embedInBatches({ embedder, texts });

  writeArtifact({
    at: VECTORS_PATH,
    artifact: {
      model: embedder.model,
      dimensions: embedder.dimensions,
      fingerprint: fingerprintChunks({ chunks }),
      ids: chunks.map((chunk) => chunk.id),
      vectors: encodeVectors({ vectors }),
    },
  });

  console.log("\nembedding the test queries…");
  const queryVectors = await embedInBatches({
    embedder,
    texts: TEST_QUERIES,
  });

  writeArtifact({
    at: QUERY_VECTORS_PATH,
    artifact: {
      model: embedder.model,
      dimensions: embedder.dimensions,
      // The query artifact is keyed by the query string itself, so its ids and
      // its texts are the same thing.
      fingerprint: fingerprintChunks({
        chunks: TEST_QUERIES.map((query) => ({ id: query, text: query })),
      }),
      ids: TEST_QUERIES,
      vectors: encodeVectors({ vectors: queryVectors }),
    },
  });

  console.log("\ndone.");
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

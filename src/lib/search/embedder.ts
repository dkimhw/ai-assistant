import { createOpenAI } from "@ai-sdk/openai";
import { embedMany } from "ai";
import { l2Normalise } from "@/lib/search/semantic";

/**
 * The provider-agnostic contract between text and vectors, plus the one
 * implementation we ship.
 *
 * Both the build script and the query path consume this interface, so swapping
 * provider is one new implementation plus a rebuild of the artifact — no
 * ranking code changes. Tests pass a stub and never touch the network.
 */

export type Embedder = {
  /** Recorded in the vector artifact so a model change can be detected. */
  model: string;
  dimensions: number;
  /** Returns one L2-normalised vector per text, in the same order. */
  embed: (opts: { texts: string[] }) => Promise<Float32Array[]>;
};

/**
 * One obvious default rather than a per-environment decision. 1536 is the
 * model's native dimensionality; `text-embedding-3-small` can return fewer,
 * which shrinks the artifact roughly proportionally at some cost to quality.
 */
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

/** `OPEN_AI_API_KEY` is what this repo's `.env` happens to call it. */
const apiKeyFromEnv = () =>
  process.env.OPENAI_API_KEY ?? process.env.OPEN_AI_API_KEY;

export const createOpenAIEmbedder = (opts?: {
  model?: string;
  dimensions?: number;
  apiKey?: string;
}): Embedder => {
  const model = opts?.model ?? DEFAULT_EMBEDDING_MODEL;
  const dimensions = opts?.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
  const apiKey = opts?.apiKey ?? apiKeyFromEnv();

  if (!apiKey) {
    throw new Error(
      "No OpenAI API key. Set OPENAI_API_KEY (or OPEN_AI_API_KEY) to embed text."
    );
  }

  const openai = createOpenAI({ apiKey });

  return {
    model,
    dimensions,
    embed: async ({ texts }) => {
      if (texts.length === 0) return [];

      const { embeddings } = await embedMany({
        model: openai.textEmbeddingModel(model),
        values: texts,
        // Always explicit: the artifact header claims this dimensionality, so
        // the request should ask for it rather than inherit the model default.
        providerOptions: { openai: { dimensions } },
      });

      return embeddings.map((embedding) =>
        l2Normalise(Float32Array.from(embedding))
      );
    },
  };
};

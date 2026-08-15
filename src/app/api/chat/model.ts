import { createOpenAI } from "@ai-sdk/openai";

/**
 * The chat model, in one place.
 *
 * A mini tier on purpose: the chat loop is given a search tool, and that job
 * needs reliable tool-call formatting, sound judgement about whether to search
 * at all, and low latency in a streaming UI — not frontier reasoning. The
 * flagship is overkill and slower; nano is less reliable at deciding *whether*
 * to call a tool and at rewriting a question into good search terms.
 *
 * Titles run a tier below, on the same provider — see `TITLE_MODEL`.
 */
export const CHAT_MODEL = "gpt-5.4-mini";

/**
 * Titles are a one-shot, tool-free call for at most 30 characters, so they run a
 * tier below the chat loop. Kept on the same provider as the chat model rather
 * than on Gemini: this repo's `.env` carries an OpenAI key and nothing else, so
 * a Gemini title call fails on every new chat — the reply streams fine, but the
 * chat stays titled "Generating title..." and the rejection surfaces as an error
 * part in the user's stream.
 */
export const TITLE_MODEL = "gpt-5.4-nano";

/**
 * `OPEN_AI_API_KEY` is what this repo's `.env` happens to call it. Same fallback
 * order as the embedder, so there is one key convention here rather than two.
 */
const apiKeyFromEnv = () =>
  process.env.OPENAI_API_KEY ?? process.env.OPEN_AI_API_KEY;

/**
 * Resolved per request rather than at module load, so a missing key fails on the
 * request that needs it with a message naming the variable — not at import time,
 * where it would take down every route in the app.
 */
const openai = () => {
  const apiKey = apiKeyFromEnv();

  if (!apiKey) {
    throw new Error(
      "No OpenAI API key. Set OPENAI_API_KEY (or OPEN_AI_API_KEY) to chat."
    );
  }

  return createOpenAI({ apiKey });
};

export const getChatModel = () => openai()(CHAT_MODEL);

export const getTitleModel = () => openai()(TITLE_MODEL);

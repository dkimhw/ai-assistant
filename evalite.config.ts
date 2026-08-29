import { defineConfig } from "evalite/config";
import config from "./vitest.config";

/**
 * One case at a time, which is a rate-limit decision rather than a taste one.
 *
 * A tool-choice case sends the whole system prompt and all seven tool schemas —
 * about 5k input tokens per call — and the suite is eighteen cases at three
 * trials each, so a full run is roughly 275k tokens. That is over a 200k
 * tokens-per-minute account limit if it goes out in forty seconds, and the run
 * comes back as a wall of `AI_RetryError` rather than as a score. Serialising it
 * spreads the same tokens over about two minutes.
 *
 * Raise this the day the account's TPM limit is raised, not before.
 */
export default defineConfig({
  viteConfig: config,
  maxConcurrency: 1,
});

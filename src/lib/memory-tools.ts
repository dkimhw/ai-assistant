import { createMemory, updateMemory } from "@/lib/persistence-layer";
import { tool } from "ai";
import { z } from "zod";

/**
 * The two tools that let the chat model write to what the assistant remembers.
 *
 * These are the first *mutating* tools in this app. Every other tool reads a
 * static, committed corpus; these write to `data/db.local.json`, and whatever
 * they write is injected into every future system prompt. That difference is
 * what most of the design here is about.
 *
 * Three decisions worth knowing before changing anything:
 *
 * - **The model may volunteer.** It does not wait to be asked. A user who
 *   mentions in passing that they are moving in March should not have to add
 *   "and remember that". This is the behaviour that makes the feature worth
 *   having, and it is also the one that can quietly fill the prompt with things
 *   nobody asked for, so the bounds live in the descriptions below rather than
 *   in a switch.
 * - **There is no delete tool, on purpose.** `updateMemory` covers revision,
 *   which is the case that actually arises. Deletion is the one memory operation
 *   with no recovery — there is no undo in a JSON file — and it is one click
 *   away in the sidebar, which is where a decision to forget something belongs.
 *   The asymmetry is the point: the model may add to and correct what the
 *   assistant knows; only the user may erase it.
 * - **A write the user cannot see is the failure mode.** Both tools take an
 *   `onWritten` callback, which the route wires to the transient
 *   `refresh-sidebar` part so the memory appears in the sidebar as it is
 *   written. Nothing here should ever succeed invisibly.
 *
 * Server-only: writes `data/db.local.json` through the persistence layer. Do not
 * import from a client component.
 */

/**
 * Bounds on one memory, enforced at the schema so an over-long one is rejected
 * before it is stored rather than trimmed after.
 *
 * They are generous relative to what a memory should be — the schema is a
 * backstop against a model pasting an email into the prompt forever, and the
 * descriptions are what actually ask for brevity. Reasoned limits, not measured
 * ones.
 */
export const MEMORY_TITLE_MAX_LENGTH = 80;
export const MEMORY_CONTENT_MAX_LENGTH = 600;

/**
 * Written for the model, not for a reader of this file.
 *
 * The "do not save" half is longer than the "do save" half deliberately. A model
 * given a memory tool and told to use it will record the conversation it is
 * having, and every one of those costs tokens on every future turn — so the
 * cases that look tempting and are wrong are named individually. The email
 * exclusion is the important one: the corpus is already searchable, and a
 * memory restating it is a second copy that can go stale.
 */
const SAVE_MEMORY_DESCRIPTION =
  "Record one lasting fact about the user, so you still know it in later " +
  "conversations. Use it without being asked — when the user mentions how they " +
  "want you to write or reply, who someone in their life is, what they are " +
  "responsible for, or a circumstance that will still be true in a month. " +
  "Do NOT use it for: anything an email says, since you can search those; " +
  "anything that will be false next week, like what they are doing today; " +
  "anything you are guessing at rather than being told; or a summary of the " +
  "conversation you are currently having. One self-contained fact per call, " +
  "written so it makes sense to someone reading it with no conversation around " +
  "it. Read the <memories> block first — if this revises something already " +
  "there, call updateMemory instead of saving a second copy.";

const UPDATE_MEMORY_DESCRIPTION =
  "Revise a memory that is already in the <memories> block, replacing its title " +
  "and content. Use it when the user corrects or supersedes something you " +
  "already know — a changed preference, a moved date, a fact that has gone out " +
  "of date — rather than saving a second memory that contradicts the first. " +
  "The id must be one you can see in <memories>; never invent one. If the " +
  "result comes back with `updated: false` the id matched nothing, which means " +
  "you invented it — call saveMemory instead of guessing another.";

export const saveMemoryInputSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(MEMORY_TITLE_MAX_LENGTH)
    .describe(
      "A short label naming what this memory is about, for the user to " +
        "recognise in a list — 'Spelling preference', 'Accountant'. Name the " +
        "subject, not the fact."
    ),
  content: z
    .string()
    .min(1)
    .max(MEMORY_CONTENT_MAX_LENGTH)
    .describe(
      "The fact itself, in one or two sentences, phrased so it stands alone " +
        "without the conversation it came from. Write 'The user prefers " +
        "British spelling', not 'they said yes to that'."
    ),
});

export const updateMemoryInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "The id of the memory to revise, exactly as it appears in square " +
        "brackets in the <memories> block. Never invent one."
    ),
  title: z
    .string()
    .min(1)
    .max(MEMORY_TITLE_MAX_LENGTH)
    .describe("The memory's label after the revision."),
  content: z
    .string()
    .min(1)
    .max(MEMORY_CONTENT_MAX_LENGTH)
    .describe(
      "The memory's full content after the revision. This replaces what was " +
        "there — write the whole fact, not just the part that changed."
    ),
});

export type SaveMemoryInput = z.infer<typeof saveMemoryInputSchema>;
export type UpdateMemoryInput = z.infer<typeof updateMemoryInputSchema>;

export type SaveMemoryOutput = {
  id: string;
  title: string;
  content: string;
};

/**
 * A miss is reported, not thrown — the same shape as `getEmails`' `missingIds`,
 * and for the same reason. A hallucinated id has to be distinguishable from a
 * successful write, and the model needs to be told what to do about it rather
 * than handed an error it will read as "the tool is broken".
 */
export type UpdateMemoryOutput =
  | { updated: true; id: string; title: string; content: string }
  | { updated: false; id: string };

/**
 * `onWritten` fires after a write lands, and only then. The route uses it to
 * refresh the sidebar mid-stream; a caller with no UI omits it.
 */
export const createSaveMemoryTool = (opts?: { onWritten?: () => void }) =>
  tool({
    description: SAVE_MEMORY_DESCRIPTION,
    inputSchema: saveMemoryInputSchema,
    execute: async ({ title, content }): Promise<SaveMemoryOutput> => {
      // Minted here rather than in the persistence layer, matching the server
      // actions: the caller owns identity.
      const memory = await createMemory({
        id: crypto.randomUUID(),
        title,
        content,
      });

      opts?.onWritten?.();

      return { id: memory.id, title: memory.title, content: memory.content };
    },
  });

export const createUpdateMemoryTool = (opts?: { onWritten?: () => void }) =>
  tool({
    description: UPDATE_MEMORY_DESCRIPTION,
    inputSchema: updateMemoryInputSchema,
    execute: async ({ id, title, content }): Promise<UpdateMemoryOutput> => {
      const memory = await updateMemory(id, { title, content });

      if (!memory) return { updated: false, id };

      opts?.onWritten?.();

      return {
        updated: true,
        id: memory.id,
        title: memory.title,
        content: memory.content,
      };
    },
  });

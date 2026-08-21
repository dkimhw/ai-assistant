import { createEmailFilterTool } from "@/lib/search/email-filter-tool";
import { createEmailGetTool } from "@/lib/search/email-get-tool";
import { createEmailSearchTool } from "@/lib/search/email-search-tool";
import { createEmailTriageTool } from "@/lib/search/email-triage-tool";
import {
  createSaveMemoryTool,
  createUpdateMemoryTool,
} from "@/lib/memory-tools";

/**
 * The tools the chat loop is given, in one place.
 *
 * Kept out of `route.ts` so the set can be handed to `safeValidateUIMessages`
 * and asserted on without dragging the route — and the persistence layer it
 * imports — into a test.
 *
 * Four tools over one corpus, splitting along the question that was asked:
 * `searchEmails` for what an email said, `filterEmails` for which emails match a
 * fact, `triageEmails` for which conversations are waiting on the user, and
 * `getEmails` for reading one in full. Which to reach for is stated in the
 * system prompt and in each tool's own description.
 *
 * The first three all answer "which emails", and the axis that separates them is
 * worth stating: search asks about content, filter asks about metadata, triage
 * asks about state. Only the third can see that nobody has replied, which is why
 * it is a tool and not a prompt instruction.
 *
 * Two more do not touch email at all. `saveMemory` and `updateMemory` write to
 * what the assistant remembers about the user, which is injected into every
 * later system prompt — the only tools here that change anything, and the reason
 * this is a factory rather than a plain object.
 *
 * Changing this set is a breaking change for persisted history in one direction
 * only: a tool can be added freely, but renaming or removing one makes every
 * chat that used it fail on its next request. See `tools.test.ts`.
 */

/**
 * The set, bound to one request.
 *
 * A factory because the memory tools need somewhere to report a write to, and
 * that somewhere is the stream writer of the request in flight. Everything else
 * here is stateless, so building the whole set per request costs an object
 * literal and keeps there being exactly one definition of what the tools are.
 *
 * `onMemoryWritten` fires after a memory is created or revised. The route uses
 * it to refresh the sidebar mid-stream; validation, which only ever looks at
 * schemas, passes nothing.
 */
export const createChatTools = (opts?: { onMemoryWritten?: () => void }) => ({
  searchEmails: createEmailSearchTool(),
  filterEmails: createEmailFilterTool(),
  triageEmails: createEmailTriageTool(),
  getEmails: createEmailGetTool(),
  saveMemory: createSaveMemoryTool({ onWritten: opts?.onMemoryWritten }),
  updateMemory: createUpdateMemoryTool({ onWritten: opts?.onMemoryWritten }),
});

/**
 * The set as schemas: what `safeValidateUIMessages` checks persisted history
 * against, and what `MyTools` is inferred from. Its tools are executable, but
 * nothing executes them — the route builds its own bound set.
 */
export const chatTools = createChatTools();

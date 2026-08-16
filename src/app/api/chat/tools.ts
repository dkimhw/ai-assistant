import { createEmailFilterTool } from "@/lib/search/email-filter-tool";
import { createEmailGetTool } from "@/lib/search/email-get-tool";
import { createEmailSearchTool } from "@/lib/search/email-search-tool";
import { createEmailTriageTool } from "@/lib/search/email-triage-tool";

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
 * Changing this set is a breaking change for persisted history in one direction
 * only: a tool can be added freely, but renaming or removing one makes every
 * chat that used it fail on its next request. See `tools.test.ts`.
 */
export const chatTools = {
  searchEmails: createEmailSearchTool(),
  filterEmails: createEmailFilterTool(),
  triageEmails: createEmailTriageTool(),
  getEmails: createEmailGetTool(),
};

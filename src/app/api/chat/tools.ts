import { createEmailSearchTool } from "@/lib/search/email-search-tool";

/**
 * The tools the chat loop is given, in one place.
 *
 * Kept out of `route.ts` so the set can be handed to `safeValidateUIMessages`
 * and asserted on without dragging the route — and the persistence layer it
 * imports — into a test.
 */
export const chatTools = {
  searchEmails: createEmailSearchTool(),
};

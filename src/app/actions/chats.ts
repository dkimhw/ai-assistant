"use server";

import { deleteChat } from "@/lib/persistence-layer";

/**
 * Server action to delete a chat
 */
export async function deleteChatAction(opts: {
  chatId: string;
}): Promise<boolean> {
  const result = await deleteChat(opts.chatId);

  return result;
}

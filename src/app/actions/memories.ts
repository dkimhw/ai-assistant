"use server";

import { generateMemoryTitle } from "@/lib/memory";
import {
  loadMemories,
  getMemory,
  createMemory,
  deleteMemory,
  DB,
} from "@/lib/persistence-layer";

/**
 * Server action to fetch all memories
 */
export async function getMemoriesAction(): Promise<DB.Memory[]> {
  return await loadMemories();
}

/**
 * Server action to fetch a single memory by ID
 */
export async function getMemoryAction(opts: {
  memoryId: string;
}): Promise<DB.Memory | null> {
  return await getMemory(opts.memoryId);
}

/**
 * Server action to create a new memory
 *
 * `title` is optional, and this is the one path where it can be: content
 * arrives here raw, typed by a person who should not have to invent a label for
 * it. The chat model's `saveMemory` tool writes its own title as part of the
 * same call it already makes, so it never comes through here without one and
 * never pays for the generation.
 *
 * `generateMemoryTitle` does not throw — a failure falls back to the opening of
 * the content, so a memory the user has already typed is never lost to a
 * provider outage.
 */
export async function createMemoryAction(opts: {
  title?: string;
  content: string;
}): Promise<DB.Memory> {
  const title =
    opts.title?.trim() ||
    (await generateMemoryTitle({ content: opts.content }));

  const memory = await createMemory({
    id: crypto.randomUUID(),
    title,
    content: opts.content,
  });

  return memory;
}

/**
 * Server action to delete a memory
 */
export async function deleteMemoryAction(opts: {
  memoryId: string;
}): Promise<boolean> {
  const result = await deleteMemory(opts.memoryId);

  return result;
}

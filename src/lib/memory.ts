import { getTitleModel } from "@/app/api/chat/model";
import type { DB } from "@/lib/persistence-layer";
import { generateText } from "ai";

/**
 * What the assistant knows about the user, and how it reaches the model.
 *
 * Memories are *injected*, not retrieved: every one of them is rendered into the
 * system prompt on every request, and there is no tool that looks one up. That
 * is a deliberate rejection of the search stack this repo already has — see
 * `docs/adr/0001-memories-are-injected-not-retrieved.md`. The short version is
 * that a retrieved memory only arrives on turns where the model thinks to go
 * looking, and the memories that matter most are needed exactly on the turns
 * that give it no reason to look.
 *
 * The consequence to keep in view is that this scales by prompt size and nothing
 * else. `MEMORY_COUNT_WARNING_THRESHOLD` in `persistence-layer.ts` is where that
 * ceiling announces itself.
 */

/**
 * How long a generated title may run. Short enough to sit in a sidebar row
 * without truncation doing the work; the model is asked for less than this and
 * this is the backstop.
 */
const TITLE_MAX_LENGTH = 60;

/**
 * The memories the model is given, as a prompt section.
 *
 * Ids are rendered because `updateMemory` needs the model to be able to name
 * one. They are prompt plumbing and not for the user, which the system prompt
 * says in as many words.
 *
 * Order is whatever the caller passes, which in practice is `loadMemories`'
 * `updatedAt` descending. Newest-first is the safe default while two memories
 * can still contradict each other — the model reads the current one before the
 * stale one — but it is a guess rather than a finding, and it argues against
 * the usual recency-at-the-end advice. Worth an eval once there are enough
 * memories to tell.
 *
 * An empty set renders as nothing at all rather than as an empty section: a
 * heading with no rows under it is an invitation to remark on having no
 * memories, which is not a thing the user asked about.
 */
export const renderMemoriesBlock = (opts: {
  memories: DB.Memory[];
}): string => {
  if (opts.memories.length === 0) return "";

  const rows = opts.memories
    .map((memory) => `- [${memory.id}] ${memory.title}: ${memory.content}`)
    .join("\n");

  return `
<memories>
Things you know about the user, from earlier conversations and from what they have told you directly. They are true unless the user says otherwise, and they apply to every reply whether or not the current question is about them.
If one of them is contradicted by what the user says now, believe the user and call \`updateMemory\` with that memory's id.

${rows}
</memories>
`;
};

/**
 * A title for a memory the user typed without one.
 *
 * This exists for the modal and not for the tools. On the tool path the chat
 * model has already written a title in its arguments, and asking a second model
 * to summarise a one-sentence fact that a model just wrote is a round-trip that
 * buys nothing. The human path is the one where content arrives raw.
 *
 * Never throws. A provider outage must not lose a memory the user has already
 * typed, so a failed generation falls back to the opening of the content — a
 * worse title, and a title.
 *
 * Server-only in practice: it needs the OpenAI key.
 */
export const generateMemoryTitle = async (opts: {
  content: string;
}): Promise<string> => {
  try {
    const result = await generateText({
      model: getTitleModel(),
      system: `You name a single memory that a personal assistant holds about its user, so the user can recognise it in a list.

Reply with the title and nothing else.
At most ${TITLE_MAX_LENGTH} characters, and shorter is better.
Sentence case. No trailing period, no quotes, no emoji.
Name the subject of the memory, not the fact about it: "Coffee order", not "The user drinks flat whites".`,
      prompt: opts.content,
    });

    const title = result.text.trim().replace(/^["']|["']$/g, "");
    if (title.length > 0) return title.slice(0, TITLE_MAX_LENGTH);
  } catch (error) {
    // Deliberate degradation, as elsewhere in this app: the memory is worth
    // more than the title on it.
    console.warn(
      "[memory] title generation failed, falling back to the content:",
      error instanceof Error ? error.message : error
    );
  }

  return titleFromContent({ content: opts.content });
};

/**
 * The fallback title: the first line of the content, cut to length. Exported so
 * the behaviour can be asserted without a provider.
 */
export const titleFromContent = (opts: { content: string }): string => {
  const firstLine = opts.content.trim().split("\n")[0] ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();

  if (collapsed.length === 0) return "Untitled memory";
  if (collapsed.length <= TITLE_MAX_LENGTH) return collapsed;

  return `${collapsed.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`;
};

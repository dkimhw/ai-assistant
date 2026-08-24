import { describe, expect, it } from "vitest";
import type { MyMessage } from "@/app/api/chat/route";
import {
  createSearchHistoryTool,
  searchHistoryInputSchema,
  type SearchHistoryOutput,
} from "@/lib/search/chat-history-tool";
import { SEARCH_HISTORY_RESULT_COUNT } from "@/lib/search/chat-history";
import { prepareWindow, WINDOW_MESSAGE_COUNT } from "@/lib/chat-window";

/**
 * The tool at its own seam: build it around a conversation and call `execute`.
 * No network and no disk — this corpus is the argument.
 *
 * Ranking itself is covered in `chat-history.test.ts`. What is left here is the
 * wiring: that the tool searches the chat it was given, and that the unbound
 * copy `safeValidateUIMessages` is built from cannot answer from someone else's
 * conversation.
 */

const say = (opts: { role: MyMessage["role"]; text: string }): MyMessage => ({
  id: opts.text,
  role: opts.role,
  parts: [{ type: "text", text: opts.text }],
});

const search = async (opts: {
  chatId?: string;
  messages?: MyMessage[];
  query: string;
}): Promise<SearchHistoryOutput> => {
  const tool = createSearchHistoryTool({
    chatId: opts.chatId,
    messages: opts.messages,
  });

  if (!tool.execute) throw new Error("the tool must be executable");

  return (await tool.execute(
    { query: opts.query },
    { toolCallId: "test-call", messages: [] }
  )) as SearchHistoryOutput;
};

describe("createSearchHistoryTool", () => {
  it("returns the messages of the chat it was given", async () => {
    const hits = await search({
      chatId: "tool-returns-messages",
      messages: [
        say({ role: "user", text: "the nursery deposit was four hundred" }),
        say({ role: "assistant", text: "noted" }),
      ],
      query: "nursery deposit",
    });

    expect(hits[0]?.text).toContain("four hundred");
    expect(hits[0]?.role).toBe("user");
  });

  it("returns an empty array when the conversation has nothing matching", async () => {
    const hits = await search({
      chatId: "tool-no-match",
      messages: [say({ role: "user", text: "hello" })],
      query: "nursery deposit",
    });

    expect(hits).toEqual([]);
  });

  it("caps what it returns", async () => {
    const hits = await search({
      chatId: "tool-caps",
      messages: Array.from({ length: 12 }, (_, i) =>
        say({ role: "user", text: `the nursery deposit, again, note ${i}` })
      ),
      query: "nursery deposit",
    });

    expect(hits.length).toBeLessThanOrEqual(SEARCH_HISTORY_RESULT_COUNT);
  });

  it("answers with nothing when it holds no conversation", async () => {
    // The shape `chatTools` builds for validation. It is never executed there,
    // and if it ever is, an empty result is the only honest answer available.
    expect(await search({ query: "nursery deposit" })).toEqual([]);
  });

  it("reaches a message the Window has already dropped", async () => {
    // The whole point, stated as one assertion: the fact is stated in the first
    // message of a long chat, the Window no longer contains it, and the tool
    // still finds it. If this ever fails because the route started handing the
    // tool a windowed list, the Backlog has quietly become unreachable again.
    const messages: MyMessage[] = [
      say({ role: "user", text: "my daughter's school is called Fernbank" }),
      ...Array.from({ length: WINDOW_MESSAGE_COUNT * 2 }, (_, i) =>
        say({ role: i % 2 === 0 ? "assistant" : "user", text: `filler ${i}` })
      ),
    ];

    const windowed = prepareWindow({ messages });
    const windowedText = JSON.stringify(windowed);

    expect(windowed).toHaveLength(WINDOW_MESSAGE_COUNT);
    expect(windowedText).not.toContain("Fernbank");

    const hits = await search({
      chatId: "tool-reaches-the-backlog",
      messages,
      query: "school called Fernbank",
    });

    expect(hits[0]?.text).toContain("Fernbank");
  });

  it("rejects an empty query at the schema", async () => {
    expect(searchHistoryInputSchema.safeParse({ query: "" }).success).toBe(false);
    expect(searchHistoryInputSchema.safeParse({ query: "school" }).success).toBe(
      true
    );
  });
});

import { renderMemoriesBlock, titleFromContent } from "@/lib/memory";
import type { DB } from "@/lib/persistence-layer";
import { describe, expect, it } from "vitest";

/**
 * The prompt block is the whole delivery mechanism for memories — there is no
 * retrieval step behind it — so the things asserted here are the things that
 * make a memory reach the model at all.
 *
 * Nothing here touches a provider. `generateMemoryTitle` is a one-shot model
 * call whose only interesting behaviour is its fallback, and that fallback is
 * `titleFromContent`, which is tested directly.
 */

const memory = (opts: Partial<DB.Memory> & { id: string }): DB.Memory => ({
  title: "Spelling",
  content: "The user writes British English.",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...opts,
});

describe("renderMemoriesBlock", () => {
  it("renders nothing at all when there are no memories", () => {
    // Not an empty section: a heading with no rows invites the model to remark
    // on having no memories, which is not a thing the user asked about.
    expect(renderMemoriesBlock({ memories: [] })).toBe("");
  });

  it("carries the id, so updateMemory has something to name", () => {
    const block = renderMemoriesBlock({ memories: [memory({ id: "mem-1" })] });

    expect(block).toContain("[mem-1]");
    expect(block).toContain("Spelling");
    expect(block).toContain("The user writes British English.");
  });

  it("keeps the order it was given", () => {
    // `loadMemories` sorts newest-first and this must not reorder it: with two
    // memories in conflict, the current one has to be read before the stale one.
    const block = renderMemoriesBlock({
      memories: [
        memory({ id: "newer", title: "Newer" }),
        memory({ id: "older", title: "Older" }),
      ],
    });

    expect(block.indexOf("Newer")).toBeLessThan(block.indexOf("Older"));
  });

  it("puts each memory on its own line", () => {
    const block = renderMemoriesBlock({
      memories: [memory({ id: "a" }), memory({ id: "b" }), memory({ id: "c" })],
    });

    expect(block.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(3);
  });
});

describe("titleFromContent", () => {
  it("uses the content when it is short enough to be a title", () => {
    expect(titleFromContent({ content: "Prefers British spelling" })).toBe(
      "Prefers British spelling"
    );
  });

  it("takes only the first line of a multi-line memory", () => {
    expect(
      titleFromContent({ content: "Coffee order\nFlat white, oat milk" })
    ).toBe("Coffee order");
  });

  it("truncates a long one with an ellipsis rather than mid-word emptiness", () => {
    const title = titleFromContent({ content: "a ".repeat(200) });

    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith("…")).toBe(true);
  });

  it("still returns something for content that is only whitespace", () => {
    // The action guards against empty content, so this is the belt to that
    // brace: a memory in the sidebar with no label at all is worse than a dull
    // one.
    expect(titleFromContent({ content: "   \n  " })).toBe("Untitled memory");
  });
});

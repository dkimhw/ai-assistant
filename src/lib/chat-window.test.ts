import { windowMessages, WINDOW_MESSAGE_COUNT } from "@/lib/chat-window";
import type { MyMessage } from "@/app/api/chat/route";
import { convertToModelMessages } from "ai";
import { describe, expect, it } from "vitest";

/**
 * The Window is one slice, so most of this is about the edges: the cut landing
 * where it should, and the cut not producing a message list the provider will
 * reject.
 */

const say = (opts: { role: MyMessage["role"]; text: string }): MyMessage => ({
  id: opts.text,
  role: opts.role,
  parts: [{ type: "text", text: opts.text }],
});

/** A conversation of `n` messages, alternating, ending on the user. */
const conversation = (n: number): MyMessage[] =>
  Array.from({ length: n }, (_, i) =>
    say({
      role: (n - i) % 2 === 1 ? "user" : "assistant",
      text: `m${i}`,
    })
  );

const texts = (messages: MyMessage[]) =>
  messages.map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));

describe("windowMessages", () => {
  it("keeps only the most recent `size` messages", () => {
    const windowed = windowMessages({ messages: conversation(50), size: 3 });

    expect(texts(windowed)).toEqual(["m47", "m48", "m49"]);
  });

  it("leaves a conversation shorter than the window untouched", () => {
    const messages = conversation(5);

    expect(windowMessages({ messages, size: 20 })).toEqual(messages);
  });

  it("leaves a conversation exactly the size of the window untouched", () => {
    const messages = conversation(20);

    expect(windowMessages({ messages, size: 20 })).toEqual(messages);
  });

  it("preserves the route's invariant that the last message is the user's", () => {
    const windowed = windowMessages({ messages: conversation(50), size: 4 });

    expect(windowed[windowed.length - 1]!.role).toBe("user");
  });

  it("defaults to the configured window size", () => {
    const windowed = windowMessages({ messages: conversation(50) });

    expect(windowed).toHaveLength(WINDOW_MESSAGE_COUNT);
  });

  it("returns nothing for a window of zero, rather than everything", () => {
    // `slice(-0)` is `slice(0)`, which is the whole array.
    expect(windowMessages({ messages: conversation(5), size: 0 })).toEqual([]);
  });

  it("never mutates the messages it was given", () => {
    const messages = conversation(50);
    const before = structuredClone(messages);

    windowMessages({ messages, size: 3 });

    // Deep, not by length: Phase 2 stubs tool output out of windowed messages,
    // and the tempting way to write that edits the parts in place — which would
    // reach through into the array being persisted.
    expect(messages).toEqual(before);
  });
});

describe("windowMessages — the cut is safe to send", () => {
  /**
   * The load-bearing one. A tool call and its result live in the same assistant
   * `UIMessage`, so cutting between messages cannot separate them — but that is
   * a property of the SDK's message shape rather than of this code, and it is
   * the assumption the whole approach rests on. Asserted against the real
   * conversion rather than reasoned about.
   */
  it("converts cleanly when the window opens on an assistant message mid-turn", () => {
    const messages: MyMessage[] = [
      say({ role: "user", text: "dropped question" }),
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-getEmails",
            toolCallId: "call_1",
            state: "output-available",
            input: { ids: ["email:1"], expandThread: false },
            output: { emails: [], missingIds: ["email:1"] },
          },
          { type: "step-start" },
          { type: "text", text: "I could not find it." },
        ],
      },
      say({ role: "user", text: "try again" }),
    ];

    // Cuts the user message that prompted the tool call away from it.
    const windowed = windowMessages({ messages, size: 2 });
    const modelMessages = convertToModelMessages(windowed);

    // Every tool result must be answered by a call earlier in the list, or the
    // provider rejects the request outright.
    const calledIds = modelMessages.flatMap((m) =>
      m.role === "assistant" && Array.isArray(m.content)
        ? m.content.flatMap((part) =>
            part.type === "tool-call" ? [part.toolCallId] : []
          )
        : []
    );
    const resultIds = modelMessages.flatMap((m) =>
      m.role === "tool"
        ? m.content.flatMap((part) =>
            part.type === "tool-result" ? [part.toolCallId] : []
          )
        : []
    );

    expect(calledIds).toEqual(["call_1"]);
    expect(resultIds).toEqual(["call_1"]);
    expect(modelMessages[modelMessages.length - 1]!.role).toBe("user");
  });
});

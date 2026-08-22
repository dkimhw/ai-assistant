import {
  openingMessages,
  prepareWindow,
  stubOldToolOutput,
  TITLE_MESSAGE_COUNT,
  windowMessages,
  WINDOW_MESSAGE_COUNT,
} from "@/lib/chat-window";
import { chatTools } from "@/app/api/chat/tools";
import type { MyMessage } from "@/app/api/chat/route";
import { convertToModelMessages, isToolUIPart, type UIMessage } from "ai";
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

/**
 * Stubbing is the other half of the Window, and it is the half with a runtime
 * failure mode: a tool part whose `output` is gone still has to convert into an
 * assistant/tool pair, or the provider rejects the request outright.
 */

const bigOutput = {
  totalMatches: 42,
  emails: Array.from({ length: 5 }, (_, i) => ({
    id: `email:${i}`,
    body: "x".repeat(2000),
  })),
};

const searched = (opts: {
  id: string;
  callId: string;
  output?: unknown;
}): MyMessage =>
  ({
    id: opts.id,
    role: "assistant",
    parts: [
      { type: "step-start" },
      {
        type: "tool-filterEmails",
        toolCallId: opts.callId,
        state: "output-available",
        input: { criteria: { from: "ana" } },
        output: opts.output ?? bigOutput,
      },
      { type: "text", text: `said ${opts.id}` },
    ],
  }) as MyMessage;

const toolOutputs = (messages: UIMessage[]) =>
  messages.flatMap((m) =>
    m.parts.flatMap((p) =>
      isToolUIPart(p) && p.state === "output-available" ? [p.output] : []
    )
  );

describe("stubOldToolOutput", () => {
  it("keeps the output of the most recent assistant message", () => {
    const stubbed = stubOldToolOutput({
      messages: [
        searched({ id: "a1", callId: "c1" }),
        say({ role: "user", text: "and?" }),
        searched({ id: "a2", callId: "c2" }),
        say({ role: "user", text: "go on" }),
      ],
    });

    expect(toolOutputs(stubbed)[1]).toEqual(bigOutput);
  });

  it("stubs the output of every earlier assistant message", () => {
    const stubbed = stubOldToolOutput({
      messages: [
        searched({ id: "a1", callId: "c1" }),
        searched({ id: "a2", callId: "c2" }),
        searched({ id: "a3", callId: "c3" }),
      ],
    });

    const outputs = toolOutputs(stubbed);

    expect(outputs[0]).not.toEqual(bigOutput);
    expect(outputs[1]).not.toEqual(bigOutput);
    expect(outputs[2]).toEqual(bigOutput);
  });

  it("outlines what the call returned rather than erasing it", () => {
    const stubbed = stubOldToolOutput({
      messages: [
        searched({ id: "a1", callId: "c1" }),
        searched({ id: "a2", callId: "c2" }),
      ],
    });

    // Scalars are cheap and the model may already have quoted them; the array
    // it cannot answer from becomes its length.
    expect(toolOutputs(stubbed)[0]).toMatchObject({
      outline: { totalMatches: 42, emails: "5 items" },
    });
  });

  it("leaves text parts alone", () => {
    const stubbed = stubOldToolOutput({
      messages: [
        searched({ id: "a1", callId: "c1" }),
        searched({ id: "a2", callId: "c2" }),
      ],
    });

    expect(texts(stubbed as MyMessage[])).toEqual(["said a1", "said a2"]);
  });

  it("leaves a conversation with no tool calls untouched", () => {
    const messages = conversation(4);

    expect(stubOldToolOutput({ messages })).toEqual(messages);
  });

  it("never mutates the messages it was given", () => {
    const messages = [
      searched({ id: "a1", callId: "c1" }),
      searched({ id: "a2", callId: "c2" }),
    ];
    const before = structuredClone(messages);

    stubOldToolOutput({ messages });

    expect(messages).toEqual(before);
  });

  it("materially shrinks a turn that ran several searches", () => {
    const heavy = [
      searched({ id: "a1", callId: "c1" }),
      say({ role: "user", text: "and?" }),
      searched({ id: "a2", callId: "c2" }),
      say({ role: "user", text: "go on" }),
    ];

    const before = JSON.stringify(heavy).length;
    const after = JSON.stringify(stubOldToolOutput({ messages: heavy })).length;

    // One of two search turns keeps its output, so the ceiling is a little over
    // half; the floor says the saving is real rather than incidental.
    expect(after).toBeLessThan(before * 0.6);
    expect(after).toBeGreaterThan(0);
  });
});

describe("stubOldToolOutput — the stub is safe to send", () => {
  /**
   * Driven off the real tool set rather than a list written here, so a seventh
   * tool is covered on the day it is added rather than the day someone
   * remembers this file.
   */
  it("converts cleanly for every tool in the set", () => {
    const toolNames = Object.keys(chatTools);

    const messages = [
      {
        id: "a1",
        role: "assistant",
        parts: toolNames.map((name, i) => ({
          type: `tool-${name}`,
          toolCallId: `call_${i}`,
          state: "output-available",
          input: {},
          output: { emails: [{ body: "x".repeat(2000) }], totalMatches: 1 },
        })),
      },
      say({ role: "user", text: "so?" }),
    ] as MyMessage[];

    const modelMessages = convertToModelMessages(
      stubOldToolOutput({ messages })
    );

    const calledIds = modelMessages.flatMap((m) =>
      m.role === "assistant" && Array.isArray(m.content)
        ? m.content.flatMap((p) => (p.type === "tool-call" ? [p.toolCallId] : []))
        : []
    );
    const resultIds = modelMessages.flatMap((m) =>
      m.role === "tool"
        ? m.content.flatMap((p) =>
            p.type === "tool-result" ? [p.toolCallId] : []
          )
        : []
    );

    expect(calledIds).toHaveLength(toolNames.length);
    expect(resultIds).toEqual(calledIds);
  });
});

describe("prepareWindow", () => {
  /**
   * An aborted turn persists a tool call with no result. Replayed, that is an
   * assistant `tool_calls` the provider gets no answer for, and it rejects the
   * request — so one abort would brick the chat it happened in.
   */
  it("drops a tool call that never got its result", () => {
    const messages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-searchEmails",
            toolCallId: "call_abandoned",
            state: "input-available",
            input: { query: "ana" },
          },
          { type: "text", text: "partial" },
        ],
      },
      say({ role: "user", text: "hello?" }),
    ] as MyMessage[];

    const modelMessages = convertToModelMessages(prepareWindow({ messages }));

    const calls = modelMessages.flatMap((m) =>
      m.role === "assistant" && Array.isArray(m.content)
        ? m.content.filter((p) => p.type === "tool-call")
        : []
    );

    expect(calls).toEqual([]);
    // The prose of the aborted turn survives; only the dangling call goes.
    expect(texts(prepareWindow({ messages }) as MyMessage[])).toContain("partial");
  });

  it("applies both rules together", () => {
    const messages = [
      ...conversation(30),
      searched({ id: "a1", callId: "c1" }),
      say({ role: "user", text: "and?" }),
      searched({ id: "a2", callId: "c2" }),
      say({ role: "user", text: "go on" }),
    ];

    const prepared = prepareWindow({ messages });

    expect(prepared).toHaveLength(WINDOW_MESSAGE_COUNT);
    expect(toolOutputs(prepared)[0]).toMatchObject({ outline: {} });
    expect(toolOutputs(prepared)[1]).toEqual(bigOutput);
  });
});

describe("openingMessages", () => {
  it("takes the start of a conversation, not the end", () => {
    expect(texts(openingMessages({ messages: conversation(50), size: 2 }))).toEqual(
      ["m0", "m1"]
    );
  });

  it("defaults to the opening message alone", () => {
    expect(openingMessages({ messages: conversation(50) })).toHaveLength(
      TITLE_MESSAGE_COUNT
    );
  });

  it("leaves a chat shorter than the slice untouched", () => {
    const messages = conversation(1);

    expect(openingMessages({ messages, size: 4 })).toEqual(messages);
  });
});

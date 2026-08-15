import { safeValidateUIMessages } from "ai";
import { describe, expect, it } from "vitest";
import type { MyMessage } from "@/app/api/chat/route";
import { chatTools } from "@/app/api/chat/tools";

/**
 * A regression test for one specific, expensive mistake.
 *
 * Once a tool call is persisted into a chat's history, that history is replayed
 * to `/api/chat` on the *next* request. If `safeValidateUIMessages` rejects it,
 * the failure does not land on the turn that searched — it lands on the one
 * after it, as a 400 and an unusable chat. It ships green and surfaces in a
 * user's face a day later, which is why it is pinned here.
 *
 * `safeValidateUIMessages` is an async pure function, so this needs no
 * `Request`, no mock model, and no persistence layer — the same rules the rest
 * of the suite plays by.
 *
 * A note on what `tools` actually does, since it is not what you might assume:
 * in `ai@5.0.113`, *omitting* `tools` does not reject a tool part — it skips
 * tool-part validation entirely, and the message passes unchecked. Passing
 * `tools` is what turns that validation on. So the argument's job is to make
 * persisted tool parts *checked* rather than merely *accepted*, and the pair of
 * failure tests below is what states that, and what stops the argument being
 * deleted as decorative.
 */

/** Hand-written, in the shape the client persists after a completed search. */
const persistedToolPart = {
  type: "tool-searchEmails",
  toolCallId: "call-1",
  state: "output-available",
  input: { query: "mortgage broker rate lock" },
  output: [
    {
      id: "e_0417",
      subject: "Rate lock confirmation",
      from: "david.xu@firsthomemortgages.co.uk",
      timestamp: "2024-03-04T09:12:00Z",
      body: "We have locked your rate at 4.6% for 60 days.",
    },
  ],
};

const historyWith = (toolPart: unknown) => [
  {
    id: "m1",
    role: "user",
    parts: [{ type: "text", text: "what did the broker say about the rate?" }],
  },
  {
    id: "m2",
    role: "assistant",
    parts: [
      toolPart,
      { type: "text", text: "David Xu confirmed the rate is locked at 4.6%." },
    ],
  },
];

describe("chat message validation", () => {
  it("accepts a persisted message carrying a tool part", async () => {
    const result = await safeValidateUIMessages<MyMessage>({
      messages: historyWith(persistedToolPart),
      tools: chatTools,
    });

    expect(result.success).toBe(true);
  });

  it("checks the tool input against the schema", async () => {
    const result = await safeValidateUIMessages<MyMessage>({
      messages: historyWith({
        ...persistedToolPart,
        input: { query: 42 },
      }),
      tools: chatTools,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a tool part naming a tool that is no longer registered", async () => {
    // The consequence worth knowing about: once `tools` is passed, renaming or
    // removing the tool makes every chat that used it fail on its next request.
    // Persisted history outlives the tool registry.
    const result = await safeValidateUIMessages<MyMessage>({
      messages: historyWith({
        ...persistedToolPart,
        type: "tool-searchEmailsRenamed",
      }),
      tools: chatTools,
    });

    expect(result.success).toBe(false);
  });
});

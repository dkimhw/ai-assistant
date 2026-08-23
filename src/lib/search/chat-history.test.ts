import type { MyMessage } from "@/app/api/chat/route";
import {
  searchChatHistory,
  SEARCH_HISTORY_TEXT_CHARACTERS,
} from "@/lib/search/chat-history";
import { describe, expect, it } from "vitest";

/**
 * The corpus here is the conversation itself, so the fixtures are conversations:
 * a handful of short messages built inline, with the word being searched for
 * appearing in exactly one of them.
 *
 * Every test uses its own chat id. The index is cached per chat for the process
 * lifetime, and sharing an id between tests would make one test's corpus visible
 * to another.
 */

const say = (opts: {
  role: MyMessage["role"];
  text: string;
  id?: string;
}): MyMessage => ({
  id: opts.id ?? opts.text,
  role: opts.role,
  parts: [{ type: "text", text: opts.text }],
});

const user = (text: string, id?: string) => say({ role: "user", text, id });
const assistant = (text: string, id?: string) =>
  say({ role: "assistant", text, id });

/**
 * The turn the search is being made from. Every fixture ends on one, because
 * every real call does — and the last message is deliberately never a hit, so a
 * fixture without one is testing a shape that cannot occur.
 */
const asking = (text = "what was that again?") => user(text, "asking");

describe("searchChatHistory", () => {
  it("finds a message by a word the user actually used", () => {
    const hits = searchChatHistory({
      chatId: "finds-a-word",
      messages: [
        user("the school run starts at half eight on Tuesdays"),
        assistant("noted"),
        user("the boiler service is booked for March"),
      ],
      query: "school run",
    });

    expect(hits[0]?.text).toContain("school run");
  });

  it("returns nothing when no term in the query appears in the chat", () => {
    const hits = searchChatHistory({
      chatId: "no-matches",
      messages: [user("the boiler service is booked for March")],
      query: "mortgage rate lock",
    });

    expect(hits).toEqual([]);
  });

  it("carries the message's id, role and position in the chat", () => {
    const hits = searchChatHistory({
      chatId: "carries-identity",
      messages: [
        user("hello", "m0"),
        assistant("the plumber is called Dorothy", "m1"),
        user("thanks", "m2"),
      ],
      query: "plumber",
    });

    expect(hits[0]).toMatchObject({
      messageId: "m1",
      position: 1,
      role: "assistant",
    });
  });

  it("indexes text parts only, never tool output", () => {
    const messages: MyMessage[] = [
      user("what did the broker say?"),
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-searchEmails",
            toolCallId: "call-1",
            state: "output-available",
            input: { query: "conservatory quotation" },
            output: [
              {
                id: "e_0417",
                subject: "Conservatory quotation",
                from: "quotes@example.com",
                timestamp: "2024-03-04T09:12:00Z",
                body: "Your conservatory quotation is attached.",
              },
            ],
          },
          { type: "text", text: "They confirmed the rate." },
        ],
      },
      asking(),
    ];

    // "conservatory" appears only inside the tool call and its output, so a hit
    // on it would mean the index had swallowed one or the other.
    expect(
      searchChatHistory({
        chatId: "text-parts-only",
        messages,
        query: "conservatory quotation",
      })
    ).toEqual([]);

    // The prose of the same message is indexed, so the message is reachable —
    // it is the parts beside the prose that are not.
    expect(
      searchChatHistory({
        chatId: "text-parts-only",
        messages,
        query: "confirmed the rate",
      })[0]?.messageId
    ).toBe("m1");
  });

  it("ranks the message that uses the query terms most above one that mentions them once", () => {
    const hits = searchChatHistory({
      chatId: "ranks-by-relevance",
      messages: [
        user("we should think about the extension at some point"),
        user("the extension quote came in at forty thousand for the extension"),
        assistant("understood"),
      ],
      query: "extension quote",
    });

    expect(hits[0]?.text).toContain("forty thousand");
  });

  it("truncates a pasted document down to the per-hit budget", () => {
    const pasted = `minutes ${"lorem ipsum ".repeat(200)}`;

    const hits = searchChatHistory({
      chatId: "truncates",
      messages: [user(pasted), asking()],
      query: "minutes",
    });

    expect(hits[0]?.text.length).toBeLessThanOrEqual(
      SEARCH_HISTORY_TEXT_CHARACTERS
    );
    expect(hits[0]?.text.endsWith("…")).toBe(true);
  });

  it("skips messages with no prose rather than indexing them empty", () => {
    // A message that is nothing but a tool call is not a document. If it were,
    // it would be an empty one, dragging the average field length down and
    // rescoring every real message in the chat.
    const hits = searchChatHistory({
      chatId: "skips-empty",
      messages: [
        {
          id: "m0",
          role: "assistant",
          parts: [
            {
              type: "tool-triageEmails",
              toolCallId: "call-1",
              state: "output-available",
              input: {},
              output: { totalMatches: 0, threads: [] },
            },
          ],
        },
        user("the loft insulation is done", "m1"),
        asking(),
      ],
      query: "loft insulation",
    });

    expect(hits.map((hit) => hit.messageId)).toEqual(["m1"]);
  });

  it("sees a new message once the conversation grows", () => {
    const chatId = "rebuilds-on-count";
    const messages = [user("hello"), asking()];

    expect(searchChatHistory({ chatId, messages, query: "guttering" })).toEqual(
      []
    );

    expect(
      searchChatHistory({
        chatId,
        messages: [
          user("hello"),
          user("the guttering needs replacing", "m1"),
          asking(),
        ],
        query: "guttering",
      })
    ).toHaveLength(1);
  });

  it("caps the results at the requested limit", () => {
    const hits = searchChatHistory({
      chatId: "caps-results",
      messages: [
        ...Array.from({ length: 10 }, (_, i) =>
          user(`the guttering needs replacing, note ${i}`, `m${i}`)
        ),
        asking(),
      ],
      query: "guttering",
      limit: 3,
    });

    expect(hits).toHaveLength(3);
  });

  it("never returns the message the search was made from", () => {
    // The model writes the query out of the user's current turn, so that turn
    // is a short document containing every term in it and ranks at or near the
    // top. Returned, it costs a slot to hand the question back.
    const hits = searchChatHistory({
      chatId: "excludes-the-current-turn",
      messages: [
        user("the guttering needs replacing", "m0"),
        assistant("noted", "m1"),
        user("what did I say about the guttering?", "asking"),
      ],
      query: "what did I say about the guttering?",
    });

    expect(hits.map((hit) => hit.messageId)).toEqual(["m0"]);
  });

  it("keeps the cap intact when the current turn would have filled a slot", () => {
    const hits = searchChatHistory({
      chatId: "cap-survives-the-exclusion",
      messages: [
        ...Array.from({ length: 4 }, (_, i) =>
          user(`the guttering needs replacing, note ${i}`, `m${i}`)
        ),
        user("what did I say about the guttering?", "asking"),
      ],
      query: "what did I say about the guttering?",
      limit: 3,
    });

    expect(hits).toHaveLength(3);
    expect(hits.map((hit) => hit.messageId)).not.toContain("asking");
  });

  it("shows the part of a long message that matched, not its opening", () => {
    // The failure this guards: a hit whose text does not contain the word it was
    // returned for reads to the model as a failed search.
    const pasted = `${"lorem ipsum ".repeat(200)} the completion date is 14 March`;

    const hits = searchChatHistory({
      chatId: "snippets-around-the-match",
      messages: [user(pasted, "m0"), asking()],
      query: "completion date",
    });

    expect(hits[0]?.text).toContain("completion date is 14 March");
    expect(hits[0]?.text.length).toBeLessThanOrEqual(
      SEARCH_HISTORY_TEXT_CHARACTERS
    );
    expect(hits[0]?.text.startsWith("…")).toBe(true);
  });

  it("rebuilds when the chat is the same length but not the same conversation", () => {
    // A chat id does not identify a client. Two tabs on one chat, or a resend
    // after an aborted turn, arrive at the same length with different messages.
    const chatId = "same-length-different-chat";

    expect(
      searchChatHistory({
        chatId,
        messages: [user("the guttering needs replacing", "m0"), asking()],
        query: "guttering",
      })
    ).toHaveLength(1);

    expect(
      searchChatHistory({
        chatId,
        messages: [user("the boiler needs servicing", "m0-other"), asking()],
        query: "guttering",
      })
    ).toEqual([]);
  });
});

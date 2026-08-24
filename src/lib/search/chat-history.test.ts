import type { MyMessage } from "@/app/api/chat/route";
import {
  searchChatHistory,
  SEARCH_HISTORY_NEIGHBOUR_CHARACTERS,
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

  it("carries the message's id and role", () => {
    const hits = searchChatHistory({
      chatId: "carries-identity",
      messages: [
        user("hello", "m0"),
        assistant("the plumber is called Dorothy", "m1"),
        user("thanks", "m2"),
      ],
      query: "plumber",
    });

    expect(hits[0]).toMatchObject({ messageId: "m1", role: "assistant" });
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

  it("anchors a snippet on the passage carrying the query, not the first term in it", () => {
    // The bug this guards, which shipped once: a common query word near the top
    // of a long paste and the answer far below it. Anchoring on the earliest
    // match returns the heading and nothing else, and the model reads a hit with
    // no completion date in it as the conversation not containing one.
    const pasted = [
      "Date: 3 March 2026. Minutes of the meeting.",
      "lorem ipsum ".repeat(200),
      "the completion date is 14 March",
    ].join(" ");

    const hits = searchChatHistory({
      chatId: "snippets-anchor-on-the-densest-passage",
      messages: [
        user("the completion is what I need to pin down", "m0"),
        user(pasted, "m1"),
        asking(),
      ],
      query: "completion date",
    });

    const hit = hits.find((candidate) => candidate.messageId === "m1");

    expect(hit?.text).toContain("completion date is 14 March");
    expect(hit?.text).not.toContain("Minutes of the meeting");
    expect(hit?.text.length).toBeLessThanOrEqual(
      SEARCH_HISTORY_TEXT_CHARACTERS
    );
  });

  it("falls back to the rarest term when the matched terms are far apart", () => {
    // No window holds both, so the anchor is decided by weight: "guttering"
    // appears in one message, "March" in several, and the passage worth showing
    // is the rare one.
    const pasted = [
      "March. March. March.",
      "lorem ipsum ".repeat(200),
      "the guttering was replaced in the end",
      "lorem ipsum ".repeat(200),
    ].join(" ");

    const hits = searchChatHistory({
      chatId: "snippets-prefer-the-rarest-term",
      messages: [
        user("March is fine", "m0"),
        user("March again", "m1"),
        user(pasted, "m2"),
        asking(),
      ],
      query: "guttering March",
    });

    const hit = hits.find((candidate) => candidate.messageId === "m2");

    expect(hit?.text).toContain("guttering was replaced");
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

/**
 * Phase 4: what a hit looks like once it arrives.
 *
 * A hit on "yes, do that" is worthless alone, and a hit the model can already
 * see in the Window is not news. Both are about the shape of the result rather
 * than about which message won, so they are grouped apart from the ranking
 * tests above.
 */
describe("searchChatHistory — the shape of a hit", () => {
  it("carries the messages either side of the one that matched", () => {
    const hits = searchChatHistory({
      chatId: "shape-neighbours",
      messages: [
        user("shall I book the surveyor for Thursday?", "m0"),
        assistant("yes, do that", "m1"),
        user("thanks", "m2"),
        asking(),
      ],
      query: "yes do that",
    });

    expect(hits[0]?.messageId).toBe("m1");
    expect(hits[0]?.before).toEqual({
      role: "user",
      text: "shall I book the surveyor for Thursday?",
    });
    expect(hits[0]?.after).toEqual({ role: "user", text: "thanks" });
  });

  it("has no neighbour before the first message of a chat", () => {
    const hits = searchChatHistory({
      chatId: "shape-start-of-chat",
      messages: [
        user("the guttering needs replacing", "m0"),
        assistant("noted", "m1"),
        asking(),
      ],
      query: "guttering",
    });

    expect(hits[0]?.before).toBeUndefined();
    expect(hits[0]?.after).toEqual({ role: "assistant", text: "noted" });
  });

  it("does not offer the user's current question as a neighbour", () => {
    // The message after the hit is the turn the search was made from. It is the
    // question the model just read; repeating it back is not context.
    const hits = searchChatHistory({
      chatId: "shape-end-of-chat",
      messages: [
        assistant("noted", "m0"),
        user("the guttering needs replacing", "m1"),
        asking(),
      ],
      query: "guttering",
    });

    expect(hits[0]?.messageId).toBe("m1");
    expect(hits[0]?.after).toBeUndefined();
  });

  it("skips a neighbour with no prose rather than offering an empty one", () => {
    const hits = searchChatHistory({
      chatId: "shape-toolonly-neighbour",
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
        user("the guttering needs replacing", "m1"),
        assistant("noted", "m2"),
        asking(),
      ],
      query: "guttering",
    });

    expect(hits[0]?.before).toBeUndefined();
    expect(hits[0]?.after).toEqual({ role: "assistant", text: "noted" });
  });

  it("truncates a neighbour harder than the hit itself", () => {
    const long = "x".repeat(SEARCH_HISTORY_TEXT_CHARACTERS * 2);

    const hits = searchChatHistory({
      chatId: "shape-long-neighbour",
      messages: [
        user(long, "m0"),
        assistant("the guttering needs replacing", "m1"),
        asking(),
      ],
      query: "guttering",
    });

    expect(hits[0]?.before?.text.length).toBeLessThanOrEqual(
      SEARCH_HISTORY_NEIGHBOUR_CHARACTERS
    );
  });

  it("says where in the chat the message was", () => {
    const hits = searchChatHistory({
      chatId: "shape-turn-position",
      messages: [
        user("hello", "m0"),
        assistant("hi", "m1"),
        user("the guttering needs replacing", "m2"),
        assistant("noted", "m3"),
        asking(),
      ],
      query: "guttering",
    });

    // One-based, because "turn 3 of 5" is what it is for.
    expect(hits[0]?.turn).toBe(3);
    expect(hits[0]?.ofTurns).toBe(5);
  });

  it("marks a hit the model can already see in the Window", () => {
    const hits = searchChatHistory({
      chatId: "shape-in-window",
      messages: [
        user("the guttering needs replacing", "m0"),
        assistant("noted", "m1"),
        asking(),
      ],
      query: "guttering",
      windowSize: 20,
    });

    expect(hits[0]?.inWindow).toBe(true);
  });

  it("marks a hit that has fallen out of the Window as news", () => {
    const hits = searchChatHistory({
      chatId: "shape-out-of-window",
      messages: [
        user("the guttering needs replacing", "m0"),
        ...Array.from({ length: 10 }, (_, i) => user(`filler ${i}`, `f${i}`)),
        asking(),
      ],
      query: "guttering",
      windowSize: 4,
    });

    expect(hits[0]?.inWindow).toBe(false);
  });

  it("spends the cap on the Backlog before the Window", () => {
    // The cap is the whole budget, and a hit inside the Window buys nothing the
    // model does not already have. Two messages say "guttering"; only one of
    // them is news, and with one slot it must be that one.
    const hits = searchChatHistory({
      chatId: "shape-backlog-first",
      messages: [
        user("the guttering needs replacing", "m0"),
        ...Array.from({ length: 10 }, (_, i) => user(`filler ${i}`, `f${i}`)),
        user("the guttering, again", "recent"),
        asking(),
      ],
      query: "guttering",
      windowSize: 4,
      limit: 1,
    });

    expect(hits.map((hit) => hit.messageId)).toEqual(["m0"]);
  });
});

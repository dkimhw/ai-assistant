import { describe, expect, it } from "vitest";
import { chunkEmail, stripQuotedText } from "@/lib/search/email-chunks";

/**
 * Quote stripping is a heuristic over conventions that vary by mail client, and
 * a miss is invisible — it shows up only as one thread crowding out the results.
 * These pin the conventions we claim to handle.
 */

// The id is the document id the layer mints; chunking only appends to it.
const email = (opts: { body: string; subject?: string }) => ({
  id: "email:e1",
  subject: opts.subject ?? "Subject",
  body: opts.body,
});

describe("stripQuotedText", () => {
  it("drops lines quoted with >", () => {
    const stripped = stripQuotedText("My reply.\n\n> their words\n> more of them");

    expect(stripped).toBe("My reply.");
  });

  it("drops everything below a Gmail-style attribution line", () => {
    const stripped = stripQuotedText(
      "Sounds good.\n\nOn Fri, Jun 14 at 10:23, Jennifer <j@example.com> wrote:\n[Original email quoted]"
    );

    expect(stripped).toBe("Sounds good.");
  });

  it("drops everything below an Outlook separator", () => {
    const stripped = stripQuotedText(
      "Thanks!\n\n-----Original Message-----\nFrom: someone@example.com\nAll of this is history."
    );

    expect(stripped).toBe("Thanks!");
  });

  it("keeps a body line that merely starts with 'From:'", () => {
    const body = "Notes from the call:\nFrom: the sales team we heard nothing.";

    expect(stripQuotedText(body)).toBe(body);
  });

  it("leaves an unquoted body untouched apart from trimming", () => {
    expect(stripQuotedText("\nHello there.\n\nBye.\n")).toBe(
      "Hello there.\n\nBye."
    );
  });
});

describe("chunkEmail", () => {
  it("prepends the subject so thread context reaches the vector", () => {
    const [chunk] = chunkEmail({
      email: email({ subject: "Exchange of Contracts", body: "Dear Sarah," }),
    });

    expect(chunk.text).toBe("Exchange of Contracts\n\nDear Sarah,");
    expect(chunk.id).toBe("email:e1#0");
  });

  it("leaves a short body as a single chunk", () => {
    const chunks = chunkEmail({ email: email({ body: "Short and sweet." }) });

    expect(chunks).toHaveLength(1);
  });

  it("splits a long body on paragraph boundaries, with overlap", () => {
    const paragraph = (n: number) => `Paragraph ${n}. ${"word ".repeat(120)}`;
    const body = [1, 2, 3, 4].map(paragraph).join("\n\n");

    const chunks = chunkEmail({ email: email({ body }) });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.id)).toEqual(
      chunks.map((_, index) => `email:e1#${index}`)
    );
    // Every chunk carries the subject, so no fragment loses its thread.
    for (const chunk of chunks) expect(chunk.text.startsWith("Subject")).toBe(true);
    // The last paragraph of one chunk opens the next, so a point made across a
    // paragraph break survives in at least one chunk whole.
    expect(chunks[0].text).toContain("Paragraph 1.");
    expect(chunks[1].text).toContain("Paragraph 1.");
    expect(chunks[1].text).toContain("Paragraph 2.");
  });

  it("excludes addresses — they are never part of the chunked text", () => {
    const [chunk] = chunkEmail({
      email: email({ body: "Call me." }),
    });

    expect(chunk.text).not.toContain("@");
  });
});

import { describe, expect, it } from "vitest";
import { tokenize } from "@/lib/search/tokenize";

describe("tokenize", () => {
  it("lowercases and splits on punctuation", () => {
    expect(tokenize("Hello, World! Nice-to-see-you?")).toEqual([
      "hello",
      "world",
      "nice",
      "see",
    ]);
  });

  it("keeps numbers", () => {
    expect(tokenize("Deposit 45000 GBP")).toEqual(["deposit", "45000", "gbp"]);
  });

  it("drops tokens of length 1", () => {
    expect(tokenize("a b cd e")).toEqual(["cd"]);
  });

  it("drops stopwords", () => {
    expect(tokenize("the cat is on the mat and it is fine")).toEqual([
      "cat",
      "mat",
      "fine",
    ]);
  });

  it("preserves unicode letters and normalises to NFKC", () => {
    expect(tokenize("Café")).toEqual(["café"]);
    // decomposed e + combining acute normalises to the same token
    expect(tokenize("Café")).toEqual(["café"]);
  });

  it("emits an email address as a whole token and as its component words", () => {
    expect(tokenize("Sent: david.xu@firsthomemortgages.co.uk today")).toEqual([
      "sent",
      "david.xu@firsthomemortgages.co.uk",
      "david",
      "xu",
      "firsthomemortgages",
      "co",
      "uk",
      "today",
    ]);
  });

  it("handles multiple addresses and surrounding text in order", () => {
    expect(tokenize("ping sarah.chen@gmail.com plus bob@a.co now")).toEqual([
      "ping",
      "sarah.chen@gmail.com",
      "sarah",
      "chen",
      "gmail",
      "com",
      "plus",
      "bob@a.co",
      "bob",
      "co",
      "now",
    ]);
  });

  it("returns an empty array for empty or punctuation-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("--- !!! ???")).toEqual([]);
  });
});

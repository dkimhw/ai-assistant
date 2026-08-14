import { describe, expect, it } from "vitest";
import { getEmailIndex, searchEmails } from "@/lib/search/emails";

describe("searchEmails", () => {
  it("indexes the whole corpus once", () => {
    expect(getEmailIndex()).toBe(getEmailIndex());
    expect(getEmailIndex().docCount).toBeGreaterThan(500);
  });

  // Smoke test, not a relevance benchmark — asserted loosely on purpose.
  it("puts the mortgage thread in the top 3 for 'mortgage pre-approval'", () => {
    const results = searchEmails({ query: "mortgage pre-approval", limit: 3 });

    expect(results).toHaveLength(3);
    expect(
      results.some((result) =>
        result.email.subject.toLowerCase().includes("mortgage")
      )
    ).toBe(true);
    expect(results[0].score).toBeGreaterThanOrEqual(results[2].score);
  });

  it("returns [] for a query with no lexical hits", () => {
    expect(searchEmails({ query: "zzzzqqqxyzzy" })).toEqual([]);
  });
});

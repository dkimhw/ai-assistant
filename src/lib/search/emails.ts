import fs from "node:fs";
import path from "node:path";
import { buildBM25Index, searchBM25, type BM25Index } from "@/lib/search/bm25";

/**
 * Email adapter over the corpus-agnostic BM25 ranker.
 *
 * Server-only: reads `data/emails.json` from disk. Do not import from a client
 * component.
 */

export type Email = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  timestamp: string;
  arcId: string;
  phaseId: number;
};

/** A starting guess to tune against evals, not a claim. */
const EMAIL_FIELD_WEIGHTS = { subject: 3, body: 1, from: 2, to: 1 };

const EMAILS_PATH = path.join(process.cwd(), "data", "emails.json");

let cachedEmails: Email[] | undefined;
let cachedEmailsById: Map<string, Email> | undefined;
let cachedIndex: BM25Index | undefined;

const loadEmails = (): Email[] => {
  cachedEmails ??= JSON.parse(fs.readFileSync(EMAILS_PATH, "utf-8")) as Email[];
  return cachedEmails;
};

const emailsById = (): Map<string, Email> => {
  cachedEmailsById ??= new Map(loadEmails().map((email) => [email.id, email]));
  return cachedEmailsById;
};

/** Memoised module singleton — the corpus is read and indexed once. */
export const getEmailIndex = (): BM25Index => {
  cachedIndex ??= buildBM25Index({
    documents: loadEmails().map((email) => ({
      id: email.id,
      fields: {
        subject: email.subject,
        body: email.body,
        from: email.from,
        to: email.to,
      },
    })),
    fieldWeights: EMAIL_FIELD_WEIGHTS,
  });
  return cachedIndex;
};

export const searchEmails = (opts: {
  query: string;
  limit?: number;
}): Array<{ email: Email; score: number }> => {
  const byId = emailsById();

  return searchBM25({
    index: getEmailIndex(),
    query: opts.query,
    limit: opts.limit,
  }).flatMap((result) => {
    const email = byId.get(result.id);
    return email ? [{ email, score: result.score }] : [];
  });
};

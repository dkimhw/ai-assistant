import fs from "node:fs";
import path from "node:path";
import { parseDocumentId } from "@/lib/search/document-id";
import type {
  DocumentChunk,
  DocumentSource,
  SearchDocument,
} from "@/lib/search/documents";
import { searchDocuments } from "@/lib/search/documents";
import { chunkEmail } from "@/lib/search/email-chunks";
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  type Embedder,
} from "@/lib/search/embedder";
import {
  assertArtifactMatches,
  decodeVectors,
  fingerprintChunks,
  type VectorArtifact,
} from "@/lib/search/vector-artifact";

/**
 * The email source adapter. All email-specific knowledge lives here and in
 * `email-chunks.ts`: where the corpus is, which fields are indexed and how
 * heavily, how a message is chunked for embedding, and where its vectors live.
 *
 * Everything below it — the document layer's registry and the three rankers —
 * sees documents, fields, and vectors, and nothing else.
 *
 * Server-only: reads `data/*.json` from disk. Do not import from a client
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

/** Namespaces every email document id: `email:email_1759404204639_rcsddgue6`. */
export const EMAIL_SOURCE_TYPE = "email";

/** A starting guess to tune against evals, not a claim. */
const EMAIL_FIELD_WEIGHTS = { subject: 3, body: 1, from: 2, to: 1 };

const REBUILD_COMMAND = "pnpm run build:vectors";

const EMAILS_PATH = path.join(process.cwd(), "data", "emails.json");
const VECTORS_PATH = path.join(process.cwd(), "data", "email-vectors.json");

let cachedEmails: Email[] | undefined;
let cachedEmailsById: Map<string, Email> | undefined;
let cachedEmailsByThreadId: Map<string, Email[]> | undefined;

/** The whole corpus, read from disk once. Server-only. */
export const getAllEmails = (): Email[] => {
  cachedEmails ??= JSON.parse(fs.readFileSync(EMAILS_PATH, "utf-8")) as Email[];
  return cachedEmails;
};

const emailsById = (): Map<string, Email> => {
  cachedEmailsById ??= new Map(getAllEmails().map((email) => [email.id, email]));
  return cachedEmailsById;
};

/**
 * One email by its **native** id — the form `searchEmails` and the chat tools
 * hand out, not the `email:`-namespaced document id the index uses.
 */
export const getEmailById = (id: string): Email | undefined =>
  emailsById().get(id);

const emailsByThreadId = (): Map<string, Email[]> => {
  if (cachedEmailsByThreadId) return cachedEmailsByThreadId;

  const byThread = new Map<string, Email[]>();
  for (const email of getAllEmails()) {
    const thread = byThread.get(email.threadId);
    if (thread) thread.push(email);
    else byThread.set(email.threadId, [email]);
  }

  cachedEmailsByThreadId = byThread;
  return byThread;
};

/**
 * Every email in a thread, oldest first — which is the order a conversation is
 * read in, and the only order that makes a reply legible against what it
 * answers. An unknown thread id yields an empty array.
 *
 * Threads in this corpus run to at most 4 messages, so sorting per call is
 * cheaper than holding a second sorted copy.
 */
export const getThreadEmails = (opts: { threadId: string }): Email[] =>
  [...(emailsByThreadId().get(opts.threadId) ?? [])].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  );

/**
 * Vectors for the email chunks, from the committed artifact.
 *
 * Throws if the artifact does not match the chunks it is being searched
 * alongside: stale vectors degrade relevance silently, which is worse than a
 * loud failure at startup. The fingerprint covers the chunk ids as well as
 * their texts, so a change to the id scheme invalidates the artifact even
 * though every embedded text is untouched.
 */
const emailVectors = (opts: { chunks: DocumentChunk[] }) => {
  const artifact = JSON.parse(
    fs.readFileSync(VECTORS_PATH, "utf-8")
  ) as VectorArtifact;

  assertArtifactMatches({
    artifact,
    model: DEFAULT_EMBEDDING_MODEL,
    dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    fingerprint: fingerprintChunks({ chunks: opts.chunks }),
    rebuildCommand: REBUILD_COMMAND,
  });

  const vectors = decodeVectors({
    vectors: artifact.vectors,
    dimensions: artifact.dimensions,
  });

  return artifact.ids.map((id, index) => ({ id, vector: vectors[index] }));
};

/**
 * The email corpus as a document source. `id` is kept native — the corpus ships
 * 547 stable ids that are worth keeping greppable against `emails.json`, and a
 * content-addressed id would move every time a body was edited.
 */
export const emailSource: DocumentSource = {
  sourceType: EMAIL_SOURCE_TYPE,
  fieldWeights: EMAIL_FIELD_WEIGHTS,
  all: () =>
    getAllEmails().map((email) => ({
      nativeId: email.id,
      fields: {
        subject: email.subject,
        body: email.body,
        from: email.from,
        to: email.to,
      },
      // Addresses are left out deliberately — see `email-chunks.ts`.
      chunkText: email.body,
    })),
  chunk: ({ document }) =>
    chunkEmail({
      email: {
        id: document.id,
        subject: document.fields.subject,
        body: document.chunkText,
      },
    }),
  vectors: emailVectors,
};

/** The `Email` a search document came from, by its native id. */
const emailOf = (document: SearchDocument): Email | undefined =>
  emailsById().get(parseDocumentId(document.id).nativeId);

/**
 * Hybrid search, narrowed to emails.
 *
 * A thin wrapper over `searchDocuments` so the search page and the chat tool
 * keep receiving `Email` objects. Ranking, fusion, and the embedder fallback all
 * live in the document layer; this only filters and maps.
 */
export const searchEmails = async (opts: {
  query: string;
  limit?: number;
  /** Defaults to the configured OpenAI embedder. Tests inject a stub and never hit the network. */
  embedder?: Embedder;
}): Promise<Array<{ email: Email; score: number }>> => {
  const results = await searchDocuments({
    query: opts.query,
    limit: opts.limit,
    // Narrowed before the limit, so `limit` means "this many emails" even once
    // a second source is registered.
    sourceTypes: [EMAIL_SOURCE_TYPE],
    embedder: opts.embedder,
  });

  return results.flatMap((result) => {
    const email = emailOf(result.document);
    return email ? [{ email, score: result.score }] : [];
  });
};

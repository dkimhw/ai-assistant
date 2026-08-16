import fs from "node:fs";
import path from "node:path";
import { parseDocumentId } from "@/lib/search/document-id";
import type {
  DocumentChunk,
  DocumentSource,
  RankedChunk,
  SearchDocument,
} from "@/lib/search/documents";
import { searchDocuments } from "@/lib/search/documents";
import { chunkEmail } from "@/lib/search/email-chunks";
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  type Embedder,
} from "@/lib/search/embedder";
import type { Reranker } from "@/lib/search/reranker";
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

/**
 * Whose inbox this is.
 *
 * Inbound and outbound have no meaning without it, and it is the one thing the
 * corpus does not state about itself. It is inferable — 546 of 547 emails carry
 * this address on one side — but inferring it on every process start is a guess
 * dressed as a lookup, and a corpus where the owner happened to be quiet would
 * silently infer the wrong person.
 *
 * The owner has a second, work address in this corpus (`sarah.chen@techflow.com`,
 * on one received email) and never sends from it. If that changes, outbound
 * detection needs a set rather than a constant.
 */
export const INBOX_OWNER = "sarah.chen.personal@gmail.com";

/**
 * Senders with nobody on the other end: no-reply addresses, order confirmations,
 * newsletters. Matched on the local part only, so the domain is irrelevant.
 *
 * This is a heuristic doing load-bearing work — it decides 158 of the 258
 * threads that are otherwise "waiting on a reply", and the honest reason it is
 * defensible is that it was checked by hand against all 56 distinct senders in
 * the corpus rather than reasoned about. It catches exactly eight, with no false
 * positives. `emails.test.ts` pins that list independently.
 *
 * What it deliberately does NOT do is generalise to role addresses. `bookings@`,
 * `info@`, `admin@`, `quotes@`, `support@`, `events@`, `surveys@` and
 * `customerservice@` are every one of them staffed by a person here, and ten of
 * those threads end on a direct question to the user. A tempting
 * "not a personal address" rule would hide the mail that most needs answering,
 * which is the exact failure the triage tool exists to prevent.
 *
 * `orders@` is the one genuinely ambiguous prefix — two threads, both receipts —
 * and is left out: two rows of noise is a cheaper mistake than the shape of rule
 * that letting it in would license.
 */
const AUTOMATED_LOCAL_PART =
  /^(no-?reply|do-?not-?reply|auto|autoconfirm|autoreply|notification|notifications|alert|alerts|newsletter|newsletters|mailer|bounce|bounces)([-._+].*)?$/i;

export const isAutomatedSender = (address: string): boolean =>
  AUTOMATED_LOCAL_PART.test(address.split("@")[0] ?? "");

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
 * A conversation reduced to the facts that say whether it needs the user.
 *
 * `awaiting` is the whole point: `"you"` means somebody wrote and the user has
 * not answered, `"them"` means the user wrote last. It is derived from who sent
 * the newest message and nothing else — no read receipts, no flags, because the
 * corpus has none. That makes it a claim about turn-taking rather than about
 * intent, and the tool that surfaces it says so.
 */
export type ThreadState = {
  threadId: string;
  messageCount: number;
  lastMessage: Email;
  awaiting: "you" | "them";
};

let cachedThreadStates: ThreadState[] | undefined;

/**
 * Every thread's state, derived once for the process lifetime — the corpus is
 * static, and this is one pass over 547 emails.
 *
 * Order is not part of the contract. Callers sort for their own purpose.
 */
export const getThreadStates = (): ThreadState[] => {
  cachedThreadStates ??= [...emailsByThreadId().entries()].map(
    ([threadId, emails]) => {
      // `reduce` rather than a sort: only the newest is wanted, and the corpus
      // order is not guaranteed to be chronological within a thread.
      const lastMessage = emails.reduce((latest, email) =>
        email.timestamp > latest.timestamp ? email : latest
      );

      return {
        threadId,
        messageCount: emails.length,
        lastMessage,
        awaiting: lastMessage.from === INBOX_OWNER ? "them" : "you",
      };
    }
  );

  return cachedThreadStates;
};

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
 * keep receiving `Email` objects. Ranking, fusion, and the embedder and
 * reranker fallbacks all live in the document layer; this only filters and maps.
 *
 * A result carries `chunk` only when a reranker ran — the passage the email won
 * on, which is what the chat tool shows the model in place of the body's
 * opening. The search page passes no reranker and is unaffected.
 */
export const searchEmails = async (opts: {
  query: string;
  limit?: number;
  /** Defaults to the configured OpenAI embedder. Tests inject a stub and never hit the network. */
  embedder?: Embedder;
  /** Off unless passed: reranking costs a model call, so a caller asks for it. */
  reranker?: Reranker;
  /** Recent conversation for the reranker, oldest first. */
  rerankContext?: string[];
}): Promise<Array<{ email: Email; score: number; chunk?: RankedChunk }>> => {
  const results = await searchDocuments({
    query: opts.query,
    limit: opts.limit,
    // Narrowed before the limit, so `limit` means "this many emails" even once
    // a second source is registered.
    sourceTypes: [EMAIL_SOURCE_TYPE],
    embedder: opts.embedder,
    reranker: opts.reranker,
    rerankContext: opts.rerankContext,
  });

  return results.flatMap((result) => {
    const email = emailOf(result.document);
    return email ? [{ email, score: result.score, chunk: result.chunk }] : [];
  });
};

import {
  appendToChatMessages,
  createChat,
  DB,
  getChat,
  updateChatTitle,
} from "@/lib/persistence-layer";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  InferUITools,
  safeValidateUIMessages,
  stepCountIs,
  streamText,
  UIMessage,
} from "ai";
import { generateTitleForChat } from "./generate-title";
import { getChatModel } from "./model";
import { chatTools } from "./tools";

export type MyTools = InferUITools<typeof chatTools>;

export type MyMessage = UIMessage<
  never,
  {
    "frontend-action": "refresh-sidebar";
  },
  MyTools
>;

/**
 * A ceiling on one turn. Five was sized for search, read, answer, with room to
 * search again after a bad first guess at phrasing.
 *
 * Three tools make a longer path legitimate rather than confused: filter to
 * establish the set, search to find the substance in it, fetch two emails in
 * full, answer. That is four steps with nothing left over for the retry the
 * original five existed to allow, so the ceiling moves with the tool count.
 *
 * Eight, not more: this bounds the cost of one confused turn, and a model that
 * has not found the answer in eight tool calls is not about to.
 */
const MAX_STEPS = 8;

/**
 * Prose in one place, so tuning retrieval behaviour stays a text edit.
 *
 * The query-writing rule is the one to expect to tune: retrieval quality here
 * rests almost entirely on the query the model writes, and the two legs reward
 * different phrasings — BM25 wants the specific terms, the embedder wants a
 * natural sentence. Asking for both in one query is the cheapest way to serve
 * both, given the tool takes a single `query`.
 *
 * Citations are specified as sender-and-subject rather than as ids or a footnote
 * format: that is what a user recognises in their own inbox, and a rule the
 * model can satisfy naturally in prose gets followed, where a citation format
 * gets followed for two turns and then drifts. The ids are in the payload for
 * the UI's benefit, not for the user to read — with the one exception that
 * `getEmails` takes them, which is why the rules say to pass them back rather
 * than print them.
 *
 * Nothing here mentions how many results to ask for — the count is fixed in each
 * tool and the model has no say in it.
 *
 * The search budget is here rather than in the tool, because it is a rule about
 * the turn and not about a call. An open-ended "try different keywords if that
 * didn't work" is a licence to spend the whole step ceiling: a question with no
 * retrieval target — "which emails are most urgent" — satisfies no search, so
 * the model rephrases until `stopWhen` cuts it off, and the user waits through
 * seven round-trips for nothing. Two attempts and then an admission is the
 * honest shape, and the questions that provoke the loop are named explicitly
 * because the model cannot otherwise tell "I chose bad words" from "no words
 * exist" — the two feel identical from inside a failed search.
 *
 * The tool-choice rules are the ones to expect to tune. Three tools over one
 * corpus mean the failure to design against is reaching for the wrong one, and
 * two specific wrong reaches are worth naming: `filterEmails`' `contains` used
 * as a cheap search, which returns literal-substring emptiness where the ranker
 * would have found the answer; and `getEmails` never called at all, because a
 * truncated body reads as complete unless the model is looking for the ellipsis.
 * Both are addressed here in prose rather than in tool behaviour, because the
 * tools cannot tell which mistake is being made and the prompt can say what to
 * do about it.
 */
const SYSTEM_PROMPT = `<task-context>
You are an email assistant that helps users find and understand information from their emails.
</task-context>

<tools>
You have three tools over the user's emails. Pick by what the question is asking for.

- \`searchEmails\` — for what an email SAID or MEANT: topics, paraphrases, "what did they say about the survey". Ranked by relevance, returns the best few
- \`filterEmails\` — for facts ABOUT emails: who sent them, who they went to, when, how many, or an exact string they contain. Returns a true total count alongside the matches
- \`getEmails\` — for reading emails you have already found, in full. Takes the ids from a search or filter result
</tools>

<rules>
- You MUST use these tools for ANY question about emails, people, amounts, dates, or specific information
- NEVER answer from your training data - always look at the actual emails first
- Write the \`query\` for \`searchEmails\` as the user's question rephrased for search: keep their natural phrasing, and include the specific names, amounts, and nouns from their question. Search is hybrid — the same query is matched both semantically and by keyword — so one well-chosen query serves both
- You get TWO attempts at \`searchEmails\` for a given question. If the first comes back empty or irrelevant, rephrase once with different keywords. If the second also fails, STOP searching and tell the user what you searched for and that you could not find it — do not keep trying new phrasings
- Some questions have no search terms at all — "what's urgent", "what needs a reply", "what should I deal with first". Relevance search cannot answer those and guessing at words like "urgent" or "ASAP" will not make it. Use \`filterEmails\` over a recent date range once, read what comes back, and reason about it yourself. Say that you looked at the recent window rather than the whole inbox
- Use \`filterEmails\` when the answer is a set or a count. State counts from its \`totalMatches\`, never from how many emails it returned — it returns a capped slice and \`totalMatches\` is the truth
- \`contains\` in \`filterEmails\` is an exact substring test, not a search. Use it for reference numbers and literal strings. If a filter comes back empty, try \`searchEmails\` before telling the user they have no such emails — a filter finds nothing when your guess at a name or a spelling was wrong
- Search and filter results are PARTIAL. \`filterEmails\` truncates a body; \`searchEmails\` returns the passage of the email that matched, which may start part-way through a long message and may leave out quoted history. A body ending in "…" has more after it
- So an email saying nothing about X in a search result is NOT evidence that the email says nothing about X. Before you quote an email, reason about its detail, or conclude it does not contain something, call \`getEmails\` with its id and read the whole thing
- Pass \`expandThread: true\` to \`getEmails\` when an email reads as a reply, so you answer against the message it replies to rather than guessing at it. It is a parameter of that tool, not a tool of its own. Say when a message is part of a longer exchange
- If an id you passed to \`getEmails\` comes back in \`missingIds\`, you invented it. Search again — do not guess another id
- Only after looking should you formulate your answer based on what you found
- Cite the emails you used: name the sender and subject of each one your answer draws on, and say when a claim comes from only one email. If nothing you found answers the question, say so plainly and say what you searched or filtered for — never fill the gap from memory
</rules>

<the-ask>
Here is the user's question. Look at their emails first, then provide your answer based on what you find.
</the-ask>`;

export async function POST(req: Request) {
  const body: {
    messages: UIMessage[];
    id: string;
  } = await req.json();

  const chatId = body.id;

  // `tools` is load-bearing: without it a persisted tool part fails validation
  // on the request *after* the one that produced it. See `tools.test.ts`.
  const validatedMessagesResult = await safeValidateUIMessages<MyMessage>({
    messages: body.messages,
    tools: chatTools,
  });

  if (!validatedMessagesResult.success) {
    return new Response(validatedMessagesResult.error.message, { status: 400 });
  }

  const messages = validatedMessagesResult.data;

  let chat = await getChat(chatId);
  const mostRecentMessage = messages[messages.length - 1];

  if (!mostRecentMessage) {
    return new Response("No messages provided", { status: 400 });
  }

  if (mostRecentMessage.role !== "user") {
    return new Response("Last message must be from the user", {
      status: 400,
    });
  }

  const stream = createUIMessageStream<MyMessage>({
    execute: async ({ writer }) => {
      let generateTitlePromise: Promise<void> | undefined = undefined;

      if (!chat) {
        const newChat = await createChat({
          id: chatId,
          title: "Generating title...",
          initialMessages: messages,
        });
        chat = newChat;

        writer.write({
          type: "data-frontend-action",
          data: "refresh-sidebar",
          transient: true,
        });

        generateTitlePromise = generateTitleForChat(messages)
          .then((title) => {
            return updateChatTitle(chatId, title);
          })
          .then(() => {
            writer.write({
              type: "data-frontend-action",
              data: "refresh-sidebar",
              transient: true,
            });
          });
      } else {
        await appendToChatMessages(chatId, [mostRecentMessage]);
      }

      const result = streamText({
        model: getChatModel(),
        system: SYSTEM_PROMPT,
        messages: convertToModelMessages(messages),
        tools: chatTools,
        stopWhen: stepCountIs(MAX_STEPS),
        // Without this a turn the user abandoned keeps running to the step
        // ceiling: every remaining search still embeds, still reranks, still
        // bills, and the request holds until it is done. `req.signal` fires when
        // the client disconnects, including when the stop button aborts the
        // fetch, so the loop ends where the user's interest in it did.
        abortSignal: req.signal,
      });

      writer.merge(
        result.toUIMessageStream({
          sendSources: true,
          sendReasoning: true,
        })
      );

      await generateTitlePromise;
    },
    generateId: () => crypto.randomUUID(),
    onFinish: async ({ responseMessage }) => {
      await appendToChatMessages(chatId, [responseMessage]);
    },
  });

  // send sources and reasoning back to the client
  return createUIMessageStreamResponse({
    stream,
  });
}

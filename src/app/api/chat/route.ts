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
 * A ceiling on one turn: search, read, answer, with room to search again after a
 * bad first guess at phrasing. Without it a confused model can loop on the tool
 * indefinitely.
 */
const MAX_STEPS = 5;

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
 * the UI's benefit, not for the user to read.
 *
 * Nothing here mentions how many results to ask for — the count is fixed in the
 * tool and the model has no say in it.
 */
const SYSTEM_PROMPT = `<task-context>
You are an email assistant that helps users find and understand information from their emails.
</task-context>

<rules>
- You MUST use the search tool for ANY question about emails, people, amounts, dates, or specific information
- NEVER answer from your training data - always search the actual emails first
- If the first search doesn't find enough information, try different keywords or search queries
- Write the \`query\` as the user's question rephrased for search: keep their natural phrasing, and include the specific names, amounts, and nouns from their question. Search is hybrid — the same query is matched both semantically and by keyword — so one well-chosen query serves both
- Only after searching should you formulate your answer based on the search results
- Cite the emails you used: name the sender and subject of each one your answer draws on, and say when a claim comes from only one email. If the results do not answer the question, say so plainly and say what you searched for — never fill the gap from memory
</rules>

<the-ask>
Here is the user's question. Search their emails first, then provide your answer based on what you find.
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

import { openingMessages, prepareWindow } from "@/lib/chat-window";
import {
  appendToChatMessages,
  createChat,
  DB,
  getChat,
  loadMemories,
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
import { buildSystemPrompt } from "./system-prompt";
import { chatTools, createChatTools } from "./tools";

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
 * Several tools make a longer path legitimate rather than confused: filter to
 * establish the set, search to find the substance in it, fetch two emails in
 * full, answer. That is four steps with nothing left over for the retry the
 * original five existed to allow, so the ceiling moves with the tool count.
 *
 * Eight, not more: this bounds the cost of one confused turn, and a model that
 * has not found the answer in eight tool calls is not about to. `triageEmails`
 * did not raise it — its whole shape is one call and then reading, and the turn
 * it replaced was the one spending all eight.
 */
const MAX_STEPS = 8;

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

  // Every memory, on every request: they are injected rather than retrieved.
  // See `@/lib/memory` and ADR 0001 for why there is no tool that looks one up.
  const memories = await loadMemories();

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

        // The opening, not the Window — a title names what a conversation is
        // about, which the first question sets and later drift does not. Nearly
        // always a no-op, since a chat being titled is one message long; it
        // matters when a chat deleted from the sidebar with its tab still open
        // replays the client's whole history into `createChat`.
        generateTitlePromise = generateTitleForChat(openingMessages({ messages }))
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
        system: buildSystemPrompt({ memories }),
        // The Window. Persistence above and the UI both keep the whole chat;
        // this is the only place a chat is shortened, and it is shortened for
        // one model call. Applied after validation so persisted tool parts are
        // still checked against their schemas, and after the append above so
        // what is written down is never what was sent.
        messages: convertToModelMessages(prepareWindow({ messages })),
        // Bound to this request so a memory write can reach this stream's
        // writer. A memory the model saves silently is the failure mode of
        // letting it save unprompted at all — the sidebar has to move.
        tools: createChatTools({
          // The whole validated list, not the Window — `searchHistory` exists to
          // reach what the Window left out, so handing it the Window would leave
          // it able to search only what the model can already see.
          chat: { id: chatId, messages },
          onMemoryWritten: () =>
            writer.write({
              type: "data-frontend-action",
              data: "refresh-sidebar",
              transient: true,
            }),
        }),
        stopWhen: stepCountIs(MAX_STEPS),
        // Without this a turn the user abandoned keeps running to the step
        // ceiling: every remaining search still embeds, still reranks, still
        // bills, and the request holds until it is done. `req.signal` fires when
        // the client disconnects, including when the stop button aborts the
        // fetch, so the loop ends where the user's interest in it did.
        abortSignal: req.signal,
        // `stopWhen` is a guillotine: it ends the turn after the Nth step
        // whatever that step was, so a turn that spends its last step on a tool
        // call ends with a tool result and no reply. The user gets a transcript
        // that stops mid-thought, which reads as a crash and is indistinguishable
        // from one.
        //
        // Taking the tools away for the final step converts that into an answer.
        // The model still has every result it gathered and can only write prose
        // with them, so the worst case becomes "here is what I found and what I
        // could not" rather than silence. It costs nothing on the turns that
        // never reach the ceiling, which is almost all of them.
        prepareStep: ({ stepNumber }) =>
          stepNumber === MAX_STEPS - 1 ? { toolChoice: "none" } : undefined,
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
    // The default swallows the error and sends "An error occurred." — which is
    // all anyone, developer included, ever sees. Three of the ways this route
    // can fail (a provider outage, a missing key, a hung rerank) produce that
    // same sentence, so the log is where the difference has to live.
    //
    // What goes back to the client stays deliberately coarse: a provider error
    // can carry a key fragment or an internal URL, and this string is rendered
    // in the transcript. Naming the stage is the most that can be said safely,
    // and it is enough to tell "retrieval broke" from "the model refused".
    onError: (error) => {
      console.error("[chat] stream failed:", error);

      return error instanceof Error && error.name === "AbortError"
        ? "Stopped."
        : "Something went wrong answering that. The details are in the server log.";
    },
    onFinish: async ({ responseMessage, isAborted }) => {
      // A disconnect still persists, on purpose — that is what makes a reply
      // survive a closed laptop, and the standard this route is written to.
      // What must not persist is a message with nothing in it: an abort during
      // the first step, or a failure before any token, otherwise writes an empty
      // assistant turn that is replayed forever as a gap in the conversation.
      //
      // `isAborted` is not the test. An abort halfway through a sentence leaves
      // something worth keeping; a clean failure at step zero leaves nothing.
      // Emptiness is the thing being guarded against, so emptiness is what gets
      // measured.
      const hasContent = responseMessage.parts.some((part) =>
        part.type === "text" ? part.text.trim().length > 0 : true
      );

      if (!hasContent) {
        console.warn(
          `[chat] discarding empty assistant message for ${chatId}`,
          { isAborted }
        );
        return;
      }

      await appendToChatMessages(chatId, [responseMessage]);
    },
  });

  // send sources and reasoning back to the client
  return createUIMessageStreamResponse({
    stream,
  });
}

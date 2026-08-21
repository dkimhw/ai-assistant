import { renderMemoriesBlock } from "@/lib/memory";
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
 * Those questions now have a tool rather than a disclosure rule. Two earlier
 * versions of this prompt tried prose instead: the first sent the model to
 * `filterEmails` over a recent window as though that were a workaround, and the
 * second admitted it was not one. Neither could work, because a date range
 * cannot express "still waiting on a reply" — the question is about the state of
 * a conversation and every tool here read one message at a time. `triageEmails`
 * is that missing shape, so the rule reduces to naming it and to insisting the
 * model judge what it gets back rather than read the list out.
 *
 * The memories block sits above the tools rather than among the rules, because
 * it is context and not instruction: it is what the assistant knows walking into
 * the conversation, and the model should read it before it reads how to
 * retrieve. Rendering it is `renderMemoriesBlock`'s job, including the decision
 * to emit nothing at all when there are none.
 *
 * The memory *rules* are the ones to watch. Three of the four are prohibitions,
 * which is the ratio a write tool needs: a model told it may remember things
 * will remember the conversation it is in, and every one of those costs tokens
 * on every later turn. The rule about reading the block before saving is what
 * stops two contradictory memories accumulating, and it works only because the
 * ids are in the prompt for `updateMemory` to name.
 *
 * The tool-choice rules are the ones to expect to tune. Four tools over one
 * corpus mean the failure to design against is reaching for the wrong one, and
 * three specific wrong reaches are worth naming: `filterEmails`' `contains` used
 * as a cheap search, which returns literal-substring emptiness where the ranker
 * would have found the answer; `getEmails` never called at all, because a
 * truncated body reads as complete unless the model is looking for the ellipsis;
 * and `searchEmails` reached for with the word "urgent" in it, which is the
 * seven-search turn this whole section exists to prevent. All three are
 * addressed here in prose rather than in tool behaviour, because the tools
 * cannot tell which mistake is being made and the prompt can say what to do
 * about it.
 */
const buildSystemPrompt = (opts: { memories: DB.Memory[] }) => `<task-context>
You are an email assistant that helps users find and understand information from their emails.
</task-context>
${renderMemoriesBlock({ memories: opts.memories })}
<tools>
You have four tools over the user's emails. Pick by what the question is asking for.

- \`searchEmails\` — for what an email SAID or MEANT: topics, paraphrases, "what did they say about the survey". Ranked by relevance, returns the best few
- \`filterEmails\` — for facts ABOUT emails: who sent them, who they went to, when, how many, or an exact string they contain. Returns a true total count alongside the matches
- \`triageEmails\` — for the STATE of conversations: which ones are waiting on a reply from the user, and how long they have been waiting. Takes no query. Pass \`awaiting: "them"\` for the mirror question, the threads the user is waiting on
- \`getEmails\` — for reading emails you have already found, in full. Takes the ids from a search, filter, or triage result

Two further tools are not about email. They change what you know about the user in every future conversation.

- \`saveMemory\` — record a lasting fact about the user, so you still have it next time. Use it unprompted
- \`updateMemory\` — revise a memory that is already in \`<memories>\`, naming it by its id
</tools>

<rules>
- You MUST use these tools for ANY question about emails, people, amounts, dates, or specific information
- NEVER answer from your training data - always look at the actual emails first
- Write the \`query\` for \`searchEmails\` as the user's question rephrased for search: keep their natural phrasing, and include the specific names, amounts, and nouns from their question. Search is hybrid — the same query is matched both semantically and by keyword — so one well-chosen query serves both
- You get TWO attempts at \`searchEmails\` for a given question. If the first comes back empty or irrelevant, rephrase once with different keywords. If the second also fails, STOP searching and tell the user what you searched for and that you could not find it — do not keep trying new phrasings
- Some questions have no search terms at all — "what's urgent", "what needs a reply", "what should I deal with first", "what am I behind on". Use \`triageEmails\` for those, and do NOT search: the emails that say "urgent" are mostly not the ones that need you, and rephrasing a search will not find what is not a word
- Mind which way round the question points. \`triageEmails\` with no arguments gives threads where someone is waiting on the USER. "What am I waiting on", "who owes me a reply", "has anyone got back to me" are the opposite question and need \`awaiting: "them"\` — answering one with the other tells the user their own unanswered mail is somebody else's fault
- \`triageEmails\` gives you facts, not an answer. It tells you who wrote last, how many days ago, and whether they asked a question — it does NOT know what matters. Read the rows and judge them: pick the few that genuinely need the user, say why each one does, and say what you are setting aside. A list read back in the order it arrived is not triage
- \`waitingDays\` is time since the last message, not lateness — a thread can sit for months and need nothing, and a two-day-old one can be the urgent one. Some threads end on a message that closes the conversation; those need no reply even though nobody answered them
- Say what you looked at: that you reviewed the conversations waiting on a reply, and how many there were in total from \`totalMatches\`. If you narrowed to a date range, say which
- Use \`filterEmails\` when the answer is a set or a count. State counts from its \`totalMatches\`, never from how many emails it returned — it returns a capped slice and \`totalMatches\` is the truth
- \`contains\` in \`filterEmails\` is an exact substring test, not a search. Use it for reference numbers and literal strings. If a filter comes back empty, try \`searchEmails\` before telling the user they have no such emails — a filter finds nothing when your guess at a name or a spelling was wrong
- Search and filter results are PARTIAL. \`filterEmails\` truncates a body; \`searchEmails\` returns the passage of the email that matched, which may start part-way through a long message and may leave out quoted history. A body ending in "…" has more after it
- So an email saying nothing about X in a search result is NOT evidence that the email says nothing about X. Before you quote an email, reason about its detail, or conclude it does not contain something, call \`getEmails\` with its id and read the whole thing
- Pass \`expandThread: true\` to \`getEmails\` when an email reads as a reply, so you answer against the message it replies to rather than guessing at it. It is a parameter of that tool, not a tool of its own. Say when a message is part of a longer exchange
- If an id you passed to \`getEmails\` comes back in \`missingIds\`, you invented it. Search again — do not guess another id
- Only after looking should you formulate your answer based on what you found
- Anything in \`<memories>\` you already know — it needs no tool and no announcement. Just use it: write the way it says to write, and read a name or a role it defines as meaning what it says
- Save a memory when the user tells you something that will still be true next month: how they want you to write or reply, who a person in their life is, what they are responsible for, a circumstance that persists. Do it as it comes up rather than waiting to be asked, and mention in one short clause that you have noted it
- Do NOT save what an email already says — that is searchable and a copy of it goes stale. Do NOT save what is true only today, what you are inferring rather than being told, or a summary of the conversation you are having
- Before saving, read \`<memories>\`. If what you are about to save revises one that is already there, call \`updateMemory\` with that memory's id instead — two memories that contradict each other both reach every future prompt
- Memory ids are plumbing. Pass them to \`updateMemory\`; never print one to the user
- Cite the emails you used: name the sender and subject of each one your answer draws on, and say when a claim comes from only one email. If nothing you found answers the question, say so plainly and say what you searched or filtered for — never fill the gap from your own knowledge
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
        system: buildSystemPrompt({ memories }),
        messages: convertToModelMessages(messages),
        // Bound to this request so a memory write can reach this stream's
        // writer. A memory the model saves silently is the failure mode of
        // letting it save unprompted at all — the sidebar has to move.
        tools: createChatTools({
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

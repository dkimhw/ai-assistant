import { getChatModel } from "@/app/api/chat/model";
import { buildSystemPrompt } from "@/app/api/chat/system-prompt";
import { chatTools } from "@/app/api/chat/tools";
import { generateText, type ModelMessage, type ToolSet } from "ai";
import { createScorer, evalite } from "evalite";

/**
 * Does the model reach for the right tool?
 *
 * The first eval in the repo, and deliberately not a relevance one. Seven tools
 * over three corpora mean the failure to design against is reaching for the
 * wrong one, and every rule in the `<tools>` block of the system prompt is
 * there because some wrong reach was observed. Those rules are prose: they can
 * be edited, reordered, or deleted, and nothing in the unit suite notices. This
 * is the thing that notices.
 *
 * Scope is one decision, and only the first one: given a question, which tool
 * does the model call, and with what arguments. Not whether the answer is good,
 * not whether the retrieval was relevant, not how the turn ends.
 *
 * **The tools are handed over without their `execute`.** What decides tool
 * choice is the name, the description and the input schema — nothing else about
 * a tool is visible to the model at the moment it chooses. Stripping `execute`
 * leaves exactly that, and buys three things: the eval never reads
 * `data/emails.json`, never spends an embedding or a rerank call, and cannot
 * drift when the corpus changes. One model call per case, and the ids in the
 * fixtures below are invented on purpose — nothing looks them up.
 *
 * It also makes the run a single step: a tool with no `execute` ends the loop
 * where it is called, so `result.toolCalls` is the first decision of the turn
 * and never a recovery from a bad one.
 *
 * Two suites rather than one scorer with a get-out. A case that declares no
 * expected arguments would have to score 1 on an arguments scorer, and a scorer
 * that returns 1 for "not applicable" quietly lifts the average of every suite
 * it is in. Splitting them keeps each number meaning one thing.
 *
 * `trialCount` is 3 because tool choice is not deterministic, and a single trial
 * per case turns a 90% model into a number that jumps between 80 and 100 for no
 * reason. The cost is three short calls per case on the mini tier.
 */

/** A tool name, or the answer that no tool was the right move. */
type ToolName = keyof typeof chatTools;

type Turn = { role: "user" | "assistant"; text: string };

/**
 * A case is the user's question plus whatever had to be said before it for the
 * question to make sense — an id for `getEmails` to fetch, a gap for
 * `searchHistory` to be looking into. `history` is written as plain turns rather
 * than as `UIMessage`s: nothing here is testing the Window or the conversion,
 * and a fixture that can be read at a glance is worth more.
 */
type ToolChoiceCase = {
  question: string;
  history?: Turn[];
};

/**
 * An expected argument value, or the set of spellings that are all right.
 *
 * `awaiting` is the field that needs the second form: it is optional and
 * `triageEmails` defaults it to `"you"`, so omitting it and passing it are the
 * same call and only `"them"` would be wrong. Scoring the omission as a miss
 * would make the suite's number report a model failure that never happened.
 */
type ExpectedValue = unknown | { oneOf: unknown[] };

type ExpectedCall = {
  tool: ToolName | "none";
  /** Only the arguments that carry the decision. Absent means unchecked. */
  input?: Record<string, ExpectedValue>;
};

type ToolCallMade = { toolName: string; input: unknown };

/**
 * The real tool set with the bodies taken off. Built by naming the two fields
 * the model actually sees, rather than by deleting `execute`, so the claim in
 * the comment above is visible in the code.
 */
const toolSchemas: ToolSet = Object.fromEntries(
  Object.entries(chatTools).map(([name, definition]) => [
    name,
    {
      description: definition.description,
      inputSchema: definition.inputSchema,
    },
  ])
);

/** The system prompt with no memories: none of these questions turn on one. */
const systemPrompt = buildSystemPrompt({ memories: [] });

const toolCallsFor = async (input: ToolChoiceCase): Promise<ToolCallMade[]> => {
  const messages: ModelMessage[] = [
    ...(input.history ?? []).map(
      (turn): ModelMessage =>
        turn.role === "user"
          ? { role: "user", content: turn.text }
          : { role: "assistant", content: turn.text }
    ),
    { role: "user", content: input.question },
  ];

  const result = await generateText({
    model: getChatModel(),
    system: systemPrompt,
    messages,
    tools: toolSchemas,
  });

  return result.toolCalls.map((call) => ({
    toolName: call.toolName,
    input: call.input,
  }));
};

/**
 * Scored on the FIRST call, not on the set. A turn that reaches the right tool
 * second has already spent a step recovering, and the rule under test is which
 * tool the question points at. `"none"` is a real expectation, and this is how
 * it is checked: no calls at all.
 */
const choseTheRightTool = createScorer<
  ToolChoiceCase,
  ToolCallMade[],
  ExpectedCall
>({
  name: "Chose the right tool",
  description:
    "1 when the first tool called is the expected one, or when a question " +
    "that needs no tool got none.",
  scorer: ({ output, expected }) => ({
    score: (output[0]?.toolName ?? "none") === expected.tool ? 1 : 0,
    metadata: { called: output.map((call) => call.toolName) },
  }),
});

const isOneOf = (value: ExpectedValue): value is { oneOf: unknown[] } =>
  typeof value === "object" && value !== null && "oneOf" in value;

const valueMatches = (opts: { got: unknown; wanted: ExpectedValue }) =>
  (isOneOf(opts.wanted) ? opts.wanted.oneOf : [opts.wanted]).some(
    (option) => JSON.stringify(opts.got) === JSON.stringify(option)
  );

/**
 * Partial credit across the arguments a case declares, because these cases each
 * turn on one field and the rest of the call is the model's business. Getting
 * `awaiting: "them"` wrong is a whole wrong answer with the right tool on it,
 * which is exactly the failure a tool-name scorer cannot see.
 */
const passedTheRightArguments = createScorer<
  ToolChoiceCase,
  ToolCallMade[],
  ExpectedCall
>({
  name: "Passed the right arguments",
  description:
    "The fraction of the arguments carrying the decision that came back " +
    "right. 0 if the tool was never called.",
  scorer: ({ output, expected }) => {
    const wanted = Object.entries(expected.input ?? {});
    const call = output.find((made) => made.toolName === expected.tool);

    if (!call) {
      return {
        score: 0,
        metadata: { called: output.map((made) => made.toolName) },
      };
    }

    const got = (call.input ?? {}) as Record<string, unknown>;
    const matched = wanted.filter(([field, value]) =>
      valueMatches({ got: got[field], wanted: value })
    );

    return { score: matched.length / wanted.length, metadata: { input: got } };
  },
});

/**
 * A prior turn that puts an email id in front of the model, so `getEmails` has
 * something to fetch and the ellipsis rule has something to bite on. The id is
 * invented — nothing executes, so nothing looks it up.
 */
const AFTER_A_SEARCH: Turn[] = [
  {
    role: "user",
    text: "What did the surveyor say about the damp?",
  },
  {
    role: "assistant",
    text:
      "I found one email: “Survey report — 14 Alder Road” from " +
      "j.pike@pikesurveying.co.uk (id `email_1759000000001`). It mentions " +
      "rising damp in the back bedroom, though the passage I have is cut off…",
  },
];

/**
 * Each case names the rule it guards. A case with no rule behind it is a case
 * nobody will fix when it fails.
 */
const TOOL_CHOICE_CASES: Array<{
  input: ToolChoiceCase;
  expected: ExpectedCall;
}> = [
  // Content: what an email said. The plain case, and the baseline the others
  // are wrong against.
  {
    input: {
      question: "What did the surveyor say about the damp in the back bedroom?",
    },
    expected: { tool: "searchEmails" },
  },
  // A set and a count, which is filter's whole job — "state counts from
  // `totalMatches`" is unreachable if the model searched instead.
  {
    input: { question: "How many emails did I get from Halifax in July?" },
    expected: { tool: "filterEmails" },
  },
  // A literal reference number. The prompt calls `contains` an exact substring
  // test and not a search; this is the direction that rule is meant to allow.
  {
    input: { question: "Find me the email with reference HX-40128 in it." },
    expected: { tool: "filterEmails" },
  },
  // No search terms exist. The named failure: `searchEmails` reached for with
  // the word "urgent" in it, which is the seven-search turn the prompt's search
  // budget exists to prevent.
  {
    input: { question: "Which of my emails are urgent?" },
    expected: { tool: "triageEmails" },
  },
  // Same shape, different words — "what am I behind on" is named in the prompt.
  {
    input: { question: "What should I deal with first this week?" },
    expected: { tool: "triageEmails" },
  },
  // The mirror question. Right tool here, and the argument is scored in the
  // other suite: answering this with the default tells the user their own
  // unanswered mail is somebody else's fault.
  {
    input: { question: "Who still owes me a reply?" },
    expected: { tool: "triageEmails" },
  },
  // A fact the user gave, which was never in an email. Searching email for it
  // finds nothing, and the prompt says so in as many words.
  {
    input: {
      question: "What did I tell you my daughter's school was called?",
      history: [
        { role: "user", text: "Draft a note to the school office." },
        {
          role: "assistant",
          text: "Happy to — what would you like it to say?",
        },
      ],
    },
    expected: { tool: "searchHistory" },
  },
  // "Earlier" belongs to both tools. This one is the conversation, and it is
  // the reach the prompt has least defence against in the tool itself.
  {
    input: {
      question: "What was the figure I gave you earlier?",
      history: [
        { role: "user", text: "Anyway — the other thing." },
        { role: "assistant", text: "Go on." },
      ],
    },
    expected: { tool: "searchHistory" },
  },
  // "Earlier" pointing the other way: the thread, not the chat.
  {
    input: {
      question: "What did they say earlier in that thread about the deposit?",
      history: AFTER_A_SEARCH,
    },
    expected: { tool: "getEmails" },
  },
  // A truncated body reads as complete unless the model is looking for the
  // ellipsis. This is the tool the prompt says is never called at all.
  {
    input: {
      question: "Read me that one in full.",
      history: AFTER_A_SEARCH,
    },
    expected: { tool: "getEmails" },
  },
  // A standing instruction about how to write, which is what memory is for —
  // and the model is told to save it unprompted.
  {
    input: {
      question: "Keep your replies to three sentences — I hate long emails.",
    },
    expected: { tool: "saveMemory" },
  },
  // The other half of the memory rules: three of the four are prohibitions,
  // because a model with a write tool will otherwise record the conversation it
  // is in. Nothing here is worth saving and nothing is worth retrieving.
  {
    input: {
      question: "Thanks, that's exactly what I needed.",
      history: AFTER_A_SEARCH,
    },
    expected: { tool: "none" },
  },
];

/**
 * The cases where the tool name is the easy half. Each declares only the fields
 * that carry the decision.
 */
const TOOL_ARGUMENT_CASES: Array<{
  input: ToolChoiceCase;
  expected: ExpectedCall;
}> = [
  {
    input: { question: "Who still owes me a reply?" },
    expected: { tool: "triageEmails", input: { awaiting: "them" } },
  },
  {
    input: { question: "Has anyone got back to me about the survey?" },
    expected: { tool: "triageEmails", input: { awaiting: "them" } },
  },
  {
    // The default direction, and the one place the omission is as right as the
    // argument — what is being tested is that it did not come back "them".
    input: { question: "What needs a reply from me?" },
    expected: {
      tool: "triageEmails",
      input: { awaiting: { oneOf: ["you", undefined] } },
    },
  },
  {
    input: { question: "Find me the email with reference HX-40128 in it." },
    expected: { tool: "filterEmails", input: { contains: "HX-40128" } },
  },
  {
    input: { question: "Read me that one in full.", history: AFTER_A_SEARCH },
    expected: { tool: "getEmails", input: { ids: ["email_1759000000001"] } },
  },
  {
    input: {
      question: "What did they say earlier in that thread about the deposit?",
      history: AFTER_A_SEARCH,
    },
    expected: { tool: "getEmails", input: { expandThread: true } },
  },
];

evalite<ToolChoiceCase, ToolCallMade[], ExpectedCall>("Tool choice", {
  data: () => TOOL_CHOICE_CASES,
  task: toolCallsFor,
  scorers: [choseTheRightTool],
  trialCount: 3,
});

evalite<ToolChoiceCase, ToolCallMade[], ExpectedCall>("Tool arguments", {
  data: () => TOOL_ARGUMENT_CASES,
  task: toolCallsFor,
  scorers: [passedTheRightArguments],
  trialCount: 3,
});

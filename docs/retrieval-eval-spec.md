# Spec: the end-to-end retrieval eval

> Status: **specification, not yet built.** The suite it describes would live at
> `src/app/api/chat/retrieval.eval.ts`, beside `tool-choice.eval.ts`.
> Read `docs/evals.md` first — this document assumes it.

## Why a second suite

`tool-choice.eval.ts` measures one decision and stops: given a question, which
tool does the model reach for, and with what arguments. It hands the tools over
**without their `execute`**, so the loop ends at the first call. That is what
makes it cheap, offline and stable — and it is also the exact boundary of what it
can see. It says nothing about what happens after the tool answers.

Everything that decides whether the user gets a true answer happens on the other
side of that boundary:

- whether the `query` the model wrote actually retrieves the right email
- whether the model notices a truncated body and calls `getEmails`
- whether it reads a thread's reply against the message it replies to
- whether it states a count from `totalMatches` rather than from the ten rows it
  can see
- whether it judges the triage rows or reads them back in the order they arrived
- whether it stops after two failed searches instead of spending the step ceiling
- whether, having found nothing, it says so rather than filling the gap

Those are the behaviours the `<rules>` block spends most of its words on, and
none of them has a single assertion behind it today. **This suite is the one that
notices.**

## What it measures

One question, one turn, run through the real agentic loop against the real
corpus: **does the assistant end the turn holding the right information, and does
its answer say so truthfully?**

Deliberately three separable numbers rather than one, because "the answer was
wrong" has three different causes and one score cannot tell them apart:

| Score | Question it answers | What a failure means |
| --- | --- | --- |
| **Retrieval** | Did the gold emails reach the model's context at all? | The query, the tool choice, or the ranker failed. Prompt or search work. |
| **Answer** | Does the reply contain the fact, and only true facts? | Retrieval worked and the model misread, over-claimed, or hallucinated. Prompt work. |
| **Conduct** | Did it cite, abstain, and stop when it should? | The turn was expensive, unsourced, or confidently empty. Prompt work. |

A case that scores 1 on retrieval and 0 on answer is a completely different bug
from one that scores 0 on both, and a single blended number hides which one you
have. Report them side by side and never average them together.

## Non-goals

- **Ranker quality in isolation.** "Is this email in the top 5 for this query"
  is a relevance eval over `searchDocuments`, with fixed queries and no model in
  the loop. It is a different suite (still unwritten) and it is cheaper; do not
  let this one grow into it. Here the query is written by the model and is part
  of what is being measured.
- **Multi-turn conversation.** One user question per case. Follow-ups,
  clarification and repair are a third suite.
- **Streaming, persistence, the Window, the UI.** Covered by the unit suite.
  `history` in a fixture is a prop for the question, not a thing under test.
- **Tone, length, formatting.**

## Shape of the harness

### The loop is the real one

`generateText` with the real bound tool set, configured exactly as `route.ts`
configures `streamText` — same `buildSystemPrompt`, same `chatTools`, same
`stopWhen: stepCountIs(MAX_STEPS)` (8), same `prepareStep` withdrawing the tools
on the final step. `generateText` rather than `streamText` because nothing here
reads a token as it arrives, and `result.steps` is the trace.

The three constants (`MAX_STEPS`, the prompt builder, the tool factory) must be
**imported**, never re-declared. A copy of the route's configuration that drifts
from the route is a suite that measures a program nobody runs.

Two things the route does that this does not: no `onMemoryWritten` callback (the
writes are real, see below), and no chat is passed unless the case needs
`searchHistory`.

### The tools execute for real

That is the whole point, and it is what makes this suite expensive where the
other is not:

- **Corpus.** Real `data/emails.json` — 547 emails, 295 threads, spanning
  2024-06-01 to 2026-10-25, owned by `INBOX_OWNER`
  (`sarah.chen.personal@gmail.com`).
- **Embedder.** Real. The unit tests get away with committed
  `data/query-vectors.json` because their queries are fixed strings; here the
  query is written by the model at run time and cannot be pre-embedded. One
  embedding call per `searchEmails`.
- **Reranker.** Real, i.e. left on, because the chat tool turns it on and this
  suite exists to measure the chat tool. One `gpt-5.4-nano` call per
  `searchEmails`.
- **Memory tools.** The two mutating tools are still in the set, because
  removing them changes tool choice. But a memory write in an eval must not land
  in `data/db.local.json`. **Point the persistence layer at a temp file for the
  duration of the run and assert nothing else about it** — a suite that pollutes
  the developer's own memory block, which is then injected into every later
  prompt, corrupts the thing it is measuring. If the persistence layer cannot be
  redirected without a code change, that change is Phase 0 of this work.

### The trace

The task returns the turn, not just its text. Everything the scorers need has to
survive serialisation into the evalite result:

```typescript
type RetrievalTrace = {
  /** The assistant's final prose. */
  text: string;
  /** Every call made, in order, with its arguments. */
  calls: Array<{ tool: string; input: unknown }>;
  /** Every email id that came back from any tool, in the order first seen. */
  retrievedIds: string[];
  /** Ids the model asked `getEmails` for and did not get back. */
  missingIds: string[];
  /** Steps used, out of MAX_STEPS. */
  steps: number;
};
```

`retrievedIds` is the union across `searchEmails`, `filterEmails`,
`triageEmails` (thread ids resolved to their emails) and `getEmails`. It is
gathered by walking `result.steps[].toolResults`, which means one small extractor
per tool output shape — the shapes differ (`Email[]`, `{ totalMatches, emails }`,
`{ totalMatches, threads }`, `{ emails, missingIds }`) and the extractor is the
only place in the suite that needs to know that.

## The scorers

### 1. `retrievedTheEvidence` — deterministic

A case declares `goldIds: string[]`: the email ids that a correct answer cannot
be written without. Score is recall — `|gold ∩ retrievedIds| / |gold|`.

Deterministic, no judge, no ambiguity. It is also the scorer that makes a
failure readable: it is the difference between "the search never found it" and
"the search found it and the model ignored it".

Where a case has several equally good routes to the same fact (the figure is in
both the original and the reply that quotes it), gold is declared as
**alternative sets** — `goldIds: [["email_a"], ["email_b", "email_c"]]` — and the
score is the best-scoring set. Do not paper over that with a lower threshold: a
threshold hides which route was taken, alternatives name them.

### 2. `answeredWithTheFact` — deterministic where it can be

Every case declares `mustContain`, and the strong preference is for facts that
can be matched **literally**: a reference number, a date, an amount, a name, a
count. Normalise (case, whitespace, thousands separators, `£`) and test for
presence. A deterministic scorer with a fixture you can read is worth more than a
judge you have to audit.

Some facts genuinely cannot be pinned to a string — "did it convey that the
survey was rescheduled because of the vendor, not the buyer" — and those get a
judge. Rules for the judge, all learned the expensive way:

- It sees the question, the answer, and the **gold fact statement**. It never
  sees the corpus and is never asked to search.
- It returns a binary with a one-line reason, not a 0–5 score. A five-point scale
  from an LLM is a two-point scale with noise on it.
- The judge is `gpt-5.4-nano`-class or better and is a *different* prompt from
  the assistant's — never the same model instance grading its own turn in
  context.
- Judged cases are tagged, and the docs report what fraction of the suite is
  judged. That fraction is a debt, not a feature.

### 3. `didNotOverclaim` — deterministic, and the one that matters most

The failure this whole app is shaped against is a confident answer from training
data. Two checks, both mechanical:

- **Cited.** The answer names a sender or subject that appears in
  `retrievedIds`' emails. An answer with no citable email in it, on a case that
  has gold, fails.
- **Fabricated.** For cases declaring `mustNotContain` — a plausible wrong figure,
  a person who is not in the corpus, a spelling the model likes to invent — the
  answer must not contain it.

Unanswerable cases (below) invert this scorer: the answer must contain an
admission and must not contain any specific claim.

### 4. `spentTheTurnWell` — deterministic

Reads `steps` and `calls`:

- No more than two `searchEmails` calls in a turn. This is the two-attempt budget
  from the prompt and it currently has **no coverage at all**.
- No duplicate call — same tool, same arguments, twice.
- `steps < MAX_STEPS`. A turn that hits the ceiling was cut off by `prepareStep`,
  not finished.

Scored as its own number rather than folded into the others, because a slow
right answer and a fast wrong one are different problems and the fix for each
makes the other worse.

## The cases

Ground truth comes from the corpus's own structure. 391 of the 547 emails carry
an `arcId` — six long-running storylines (`house_purchase` 82, `consulting_growth`
80, `wedding_planning` 62, `new_zealand_trip` 61, `photography_exhibition` 53,
`climbing_progression` 53) — and the remaining 156 are unarced traffic. An arc is
a coherent set of facts with a beginning and an end, which is exactly what a
retrieval question needs, and the unarced 156 are the distractors that make
finding it non-trivial.

**Every case is authored by reading the actual emails and writing the gold ids
down by hand.** A fixture generated from the corpus tests the generator. Budget
this: it is the expensive part of the work and it is not skippable.

Eight kinds, each with the failure it exists to catch:

1. **Single-hop lookup.** One email holds the fact; the question paraphrases it
   rather than quoting it. Catches: the model writing a query that serves the
   keyword leg and starves the semantic one, or vice versa.
2. **The truncation trap.** The fact sits past
   `EMAIL_SEARCH_BODY_CHARACTERS` (1200) in a long body, so the search result
   ends in an ellipsis and *reads as complete*. A correct turn calls `getEmails`.
   This is the named failure the prompt says most about and the one no current
   test can see.
3. **The thread hop.** The question is about a reply whose meaning is in the
   message it replies to. A correct turn passes `expandThread: true`. Gold is the
   parent's id, which the model was never handed — it can only arrive through the
   expansion.
4. **The count.** "How many emails from X in July." `filterEmails` returns a
   capped ten (`EMAIL_FILTER_RESULT_COUNT`) with the true `totalMatches` beside
   it; pick a case where the true count is above ten so that stating the row
   count is a visibly wrong answer. Scored literally on the number.
5. **The state question.** "What am I behind on." `triageEmails` returns up to
   fifteen rows of facts and no ranking. Gold is not a set of ids but a
   behaviour: the answer names a few threads, says why each needs the user, and
   says what it set aside. Judged, and the reason judging is tolerable here is
   that the row set is deterministic even though the judgement over it is not.
6. **The wrong-way-round pair.** The same shape asked in both directions
   (`awaiting: "you"` / `"them"`). Tool-choice already scores the argument; this
   scores whether the *prose* answers the question that was asked.
7. **The unanswerable.** A question whose answer is genuinely not in 547 emails,
   phrased so that a plausible answer exists in the model's training data. Two
   searches, then an admission naming what was searched for. `mustContain`: the
   admission. `mustNotContain`: the plausible fabrication. **Include at least one
   near-miss** — a fact the corpus almost has — because the easy version of this
   case is passed by any model that searches at all.
8. **The conversation, not the corpus.** A fact the user stated in an earlier
   turn, with a `history` long enough that it falls outside the Window. Correct is
   `searchHistory`, an answer that restates the substance, and *no email search*.
   This is the one case kind whose fixture is a chat rather than a question, and
   it needs `createChatTools({ chat })` bound with the whole message list.

Aim for **20–24 cases**, roughly three per kind, spread across at least four
arcs so that no single storyline's phrasing dominates the number.

## Cost, and why the shape of the suite is what it is

Per case: one system prompt (~5k tokens) times the number of steps, plus one
embedding and one `gpt-5.4-nano` rerank per `searchEmails`, plus the judge calls.
A three-step turn is roughly 20k input tokens. At 24 cases:

| Trials | Model calls (approx) | Input tokens (approx) | Wall clock at `maxConcurrency: 1` |
| --- | --- | --- | --- |
| 1 | ~90 | ~500k | 4–6 min |
| 3 | ~270 | ~1.5M | 12–18 min |

Two consequences, both decisions rather than observations:

- **`trialCount` is 2 here, not 3.** Tool choice can afford three trials because
  a case is one short call. An end-to-end case is a multi-step turn with
  embedding and rerank calls hanging off it, and the third trial costs more than
  the variance it removes is worth. Revisit if the numbers turn out to jump.
- **`maxConcurrency` stays 1** for the same rate-limit reason
  `evalite.config.ts` already gives, and it is now the binding constraint on how
  long a run takes. A run of this suite is a coffee, not a keystroke — so it is
  a pre-merge and nightly gate, not something to sit in a watch loop. `pnpm run
  eval` in watch mode should be able to run one suite; if evalite cannot filter,
  that is a reason to keep the file separate rather than to merge the two.

**Caching cuts both ways.** Evalite caches model output, so a second run over an
unchanged suite is instant — but this suite's non-determinism is not only in the
chat model. Report the baseline from a `--noCache` run and say so in
`docs/evals.md`, exactly as the tool-choice baseline does.

## Phasing

Do not build all four scorers before the first case runs.

- **Phase 0 — make the writes safe.** Redirect the persistence layer to a temp
  store for an eval run. Nothing else in this spec is safe to run until this is
  true.
- **Phase 1 — the harness and one number.** `RetrievalTrace`, the extractor,
  `retrievedTheEvidence`, and six single-hop cases. This alone answers "does the
  model's own query find the email", which is the question the tuning comments in
  `emails.ts` and `rrf.ts` are still waiting on.
- **Phase 2 — the answer.** `answeredWithTheFact` with literal matching only, and
  the truncation, thread-hop and count cases. Deliberately no judge yet: if a
  case cannot be scored literally at this stage, it waits.
- **Phase 3 — conduct.** `didNotOverclaim`, `spentTheTurnWell`, the unanswerable
  cases and the search budget. This is where the prompt's admission rules get
  their first coverage.
- **Phase 4 — the judged remainder.** The triage and state cases, the judge, and
  the `searchHistory` case with its long chat fixture.

Each phase ends with `docs/evals.md` updated with the new baseline. A suite whose
number is not written down is a suite nobody can tell has regressed.

## Open questions

- **Does the corpus need a frozen copy?** The suite's gold ids are stable as long
  as `data/emails.json` is. Appending an email changes rankings and can silently
  move a case from pass to fail for a reason that has nothing to do with the
  model. A committed `data/emails.eval.json` fixes that and costs a source
  registry indirection; a stamp assertion (fail loudly if the corpus stamp is not
  the one the gold was authored against) is the cheap version and probably the
  right first move.
- **Is `retrievedIds` recall the right retrieval score, or should position
  matter?** Recall is honest about what reached the model. It says nothing about
  an answer built from the fifth result when the first was better. Position is a
  relevance-suite concern; the risk is that this suite quietly becomes one.
- **How is a judged case's disagreement adjudicated?** Two judges and a tie-break
  is the standard answer and doubles the cost of the judged fraction. Deferred
  until Phase 4 shows whether the judge is actually noisy here.
- **Does the memory-write path belong in this suite at all?** It is retrieval's
  mirror — what the assistant knows without looking — and it has the same
  "did it happen, was it right" shape. Probably its own suite; noted so it is not
  forgotten.

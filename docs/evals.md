# Evals in this repo

A test asks whether the code does what it says. An eval asks whether the *model*
does. The unit suite cannot answer the second question — every rule in the system
prompt is prose, and prose can be edited, reordered or deleted without a single
vitest assertion noticing.

Status as of this document: **one suite, `src/app/api/chat/tool-choice.eval.ts`,
18 cases, 3 trials each — 54 evals.** It scores tool choice. It does not score
relevance; that suite is still unwritten, and the tuning comments in `emails.ts`,
`docs/bm25-search.md` and `rrf.ts` are still waiting on it.

**Baseline: 98%** on `gpt-5.4-mini`, from an uncached run of about 70 seconds.
The one case that does not hold is the unprompted save: told "keep your replies
to three sentences — I hate long emails", the model reached for `saveMemory` on
two trials out of three and simply agreed on the third. Every other case is 3/3,
including both halves of the `searchEmails`/`searchHistory` ambiguity. That
single number is the point of the suite — the prompt rules can now be edited
against it rather than against a memory of how the last chat went.

## Running them

```
pnpm run eval       # watch mode, with the evalite UI on :3006
pnpm run eval:run   # once, exits non-zero if a case fails
```

Both call the real chat model, so both need `OPENAI_API_KEY` (or
`OPEN_AI_API_KEY`) in `.env` — the same key convention as the app, resolved in
`model.ts`. Evalite loads `.env` itself; there is no setup file.

Model outputs are cached, so a second run over an unchanged suite is instant and
free. A run that scores 100% off the cache is telling you about the sampling that
happened on the *first* run, not about three fresh draws — pass `--noCache` when
the number is the thing you want to trust.

`maxConcurrency` is 1 in `evalite.config.ts`, and that is a rate-limit decision
rather than a taste one: each case sends the whole system prompt and all seven
tool schemas, so a full run is around 275k input tokens, and firing that at a
200k-per-minute account returns a wall of `AI_RetryError` instead of a score.

## What the tool-choice suite measures

Seven tools over three corpora — email, the chat's own Backlog, and the memory
store — mean the failure to design against is reaching for the wrong one. The
`<tools>` block and the `<rules>` block of the system prompt exist almost
entirely to prevent specific wrong reaches, and each was written against an
observed one. The suite's cases are those failures, one per case, with a comment
naming the rule it guards. A case with no rule behind it is a case nobody will
fix when it fails.

Two suites, deliberately:

- **Tool choice** — the first tool the model calls, or none. Scored on the first
  call because a turn that reaches the right tool second has already spent a step
  recovering.
- **Tool arguments** — the subset of cases where the tool name is the easy half.
  `triageEmails` with the wrong `awaiting` is a whole wrong answer with the right
  tool on it: it tells the user their own unanswered mail is somebody else's
  fault.

They are separate rather than one scorer with a get-out, because a case
declaring no expected arguments would have to score 1 on an arguments scorer, and
a scorer that returns 1 for "not applicable" quietly lifts the average of every
suite it sits in.

## The tools are handed over without their `execute`

What decides tool choice is the name, the description and the input schema —
nothing else about a tool is visible to the model at the moment it chooses. The
eval builds its tool set by naming exactly those two fields, and that buys three
things: it never reads `data/emails.json`, never spends an embedding or a rerank
call, and cannot drift when the corpus does. The email ids in the fixtures are
invented on purpose; nothing looks them up.

It also makes each case a single model call. A tool with no `execute` ends the
loop where it is called, so `result.toolCalls` is the first decision of the turn
and never a recovery from a bad one.

The cost of this is the boundary of what the suite can see: it says nothing about
what happens *after* the tool answers — whether the model reads the result,
whether it recovers from an empty one, whether it restates what it recovered.
Those are a different eval, and the two-attempt search budget in particular has
no coverage at all.

## Why `system-prompt.ts` exists

`buildSystemPrompt` was inline in `route.ts` until this suite needed it. The
prompt and the tool set are the two halves of every tool-choice decision, and the
eval needs both without dragging the route — and the persistence layer it imports
— into an eval run. `tools.ts` was split out of the route for the same reason a
release earlier.

## Reading a failure

The scorers attach metadata: which tools were actually called, and what arguments
the winning call carried. Between that and the evalite UI's trace view, a failing
case usually reads as one of three things — the prompt rule is missing, the rule
is there but the tool description contradicts it, or the case itself is genuinely
ambiguous and the expectation is wrong. The third happens: `"earlier"` belongs to
both `searchEmails` and `searchHistory`, and two cases in the suite are there
precisely because that word is the ambiguity.

An optional argument that the tool defaults is not a failure. `awaiting` is
optional and `triageEmails` defaults it to `"you"`, so omitting it and passing it
are the same call; the arguments scorer takes a `oneOf` of acceptable spellings
for exactly that reason. Scoring the omission as a miss would make the number
report a model failure that never happened.

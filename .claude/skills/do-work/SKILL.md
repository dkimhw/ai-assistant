---
name: do-work
description: End-to-end loop for a single unit of work in this repo — plan it, implement it, verify with `pnpm typecheck` and `pnpm run test`, then commit. Use when the user asks to build a feature, fix a bug, or "do this piece of work" and wants it taken from plan through to a commit.
---

# Do Work

One unit of work, start to finish: **plan → implement → verify → commit.** Do not skip stages and do not reorder them.

A "unit of work" is one coherent change — a feature, a bug fix, one phase of a plan in `./plans/`. If the request spans several units, split it and run this skill per unit.

## 1. Plan (optional if there is a plan file)

Load the `coding-standards` skill before writing any code.

Explore first: find the existing routes, services, components, and tests the change touches. Match what's there rather than inventing a new pattern.

Then write a short plan in your response — not a file — covering:

- **Goal**: one sentence on the behavior being added or fixed
- **Files**: which files get created or changed, and why
- **Seams**: which service functions get tests (see the `tdd` skill)
- **Out of scope**: anything nearby you are deliberately not touching

Show the plan to the user and get agreement before implementing. Skip the check-in only if the user explicitly said to go straight through.

If the work comes from a plan file in `./plans/`, use that phase as the goal and still list files and seams.

## 2. Implement

Work in vertical slices — one seam at a time, each slice complete through service, route, and UI — rather than one layer at a time.

Each slice runs **red → green → refactor** (`tdd` skill). Services in this repo require tests; routes and components do not.

Run this loop, in order, for every slice:

1. **Write a single failing test** for the smallest slice of behavior that is still worth shipping — at an agreed seam, one assertion of user-visible behavior. Not two tests, not the whole feature.
2. **Run it and confirm it fails** (`pnpm vitest run <path>`), and that it fails for the reason you expect. A test that passes on first run, or fails on a typo or import error, is not a red — fix that and run again.
3. **Write the minimum code to make it pass** (green). No speculative generality, no features this test doesn't demand.
4. **Refactor if needed, keeping tests green** — only on code this slice touched. Improve names, remove the duplication the slice just created, pull out a helper. Do not change behavior and do not edit the test to accommodate the change. Re-run the test after: still green, or revert the refactor.
5. **Repeat for the next slice.** Move on only once the current slice is green and clean.

Rules:

- Never refactor on red — get to green first, then clean up.
- If a refactor turns out to want a behavior change, stop and start a new red at step 1 instead.
- Step 4 is optional per slice. Skipping it is fine; skipping steps 1–2 is not.

## 3. Verify

Feedback loops, cheapest first. Run them **during** implementation, not only at the end.

```sh
pnpm typecheck            # after each meaningful edit
pnpm vitest run <path>    # the test file for the slice you just wrote
pnpm run test             # full suite, before committing
```

Rules:

- A red typecheck or test blocks progress — fix it before writing more code.
- Fix the cause, never the symptom. Do not loosen types, cast to `any`, delete an assertion, or skip a test to get green.
- If a failure is pre-existing and unrelated, say so explicitly and leave it alone.
- Both `pnpm typecheck` and `pnpm run test` must pass clean before stage 4.

<verification-gate>
Do NOT commit until `pnpm typecheck` and `pnpm run test` have both been run in this session and both passed.
</verification-gate>

## 4. Commit

Only after the gate above.

1. `git status` and `git diff` — review every change. Nothing unrelated, no debug logging, no stray files.
2. Stage only the files belonging to this unit of work.
3. Commit with a message that says what changed and why, in the style of recent commits (`git log --oneline -10`).
4. Do not push, open a PR, or merge unless the user asks.

If the current branch is `main`, create a branch first.

## Report

Close with: what was built, which files changed, the typecheck/test results, the commit SHA, and anything left out of scope.

## Related skills

- `coding-standards` — house style; load in stage 1
- `tdd` — seams, good tests, the red → green → refactor loop
- `prd-to-plan` — when the work is big enough to need a multi-phase plan file first
- `code-review` — optional review pass before stage 4

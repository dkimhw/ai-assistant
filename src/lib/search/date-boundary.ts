import { z } from "zod";

/**
 * Date boundaries as a tool parameter: the schema fragment a model fills in, and
 * the parsing that turns what it wrote into an instant.
 *
 * Extracted from `email-filter-tool.ts` when `email-triage-tool.ts` needed the
 * same `after`/`before` pair. Two tools parsing dates two ways is one of the
 * quieter ways an assistant starts contradicting itself — "emails before March"
 * and "threads before March" have to mean the same March.
 *
 * Knows nothing about emails. Takes strings, returns milliseconds.
 */

/**
 * Accepts `YYYY-MM-DD` or an ISO-8601 datetime, and nothing else. A model asked
 * for a date will otherwise offer "last tuesday" or "June 2024", and a boundary
 * that silently fails to parse is a filter that silently matches everything —
 * the failure this rejects at the door.
 *
 * The timezone designator is optional, and its absence means UTC. JavaScript
 * reads a bare `2024-06-01T09:00:00` as *local* time while reading a bare
 * `2024-06-01` as UTC, which would put the two forms hours apart for the same
 * intended instant; `asUtc` below removes that difference rather than leaving it
 * to surprise someone. A model that emits a datetime usually emits it without a
 * zone, so rejecting the form outright would cost a wasted step to discover.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_BOUNDARY =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const HAS_TIMEZONE = /(Z|[+-]\d{2}:\d{2})$/;

/** A datetime with no zone is UTC, matching how the date-only form parses. */
const asUtc = (value: string) =>
  ISO_DATE.test(value) || HAS_TIMEZONE.test(value) ? value : `${value}Z`;

/**
 * The shape check is a `.regex`, not a `.refine`, because only the former
 * survives into the JSON Schema the model is shown — a refinement is invisible
 * to it, and an invisible rule can only be discovered by breaking it. The
 * `.refine` that follows catches what a pattern cannot: `2024-13-45` is
 * well-formed and not a date.
 */
export const dateBoundary = (opts: { description: string }) =>
  z
    .string()
    .regex(ISO_BOUNDARY, "expected YYYY-MM-DD or an ISO-8601 datetime")
    .refine((value) => !Number.isNaN(Date.parse(asUtc(value))), {
      message: "not a real date",
    })
    .describe(opts.description)
    .optional();

/**
 * A bare `YYYY-MM-DD` covers the whole day: the start of it for `after`, the end
 * of it for `before`. Anything else — a full datetime — is used as given.
 *
 * The alternative, treating a bare date as midnight at both ends, makes
 * `before: "2024-06-01"` exclude everything actually sent on the 1st. That is
 * the kind of off-by-one nobody notices in an answer, which is why it is spelled
 * out here and pinned by a boundary test.
 */
export const boundaryMs = (opts: { value: string; edge: "start" | "end" }) =>
  Date.parse(
    ISO_DATE.test(opts.value) && opts.edge === "end"
      ? `${opts.value}T23:59:59.999Z`
      : asUtc(opts.value)
  );

/**
 * The `after`/`before` test both tools share. Absent boundaries do not
 * constrain, which is what makes an unwindowed call mean "all of time" rather
 * than "nothing".
 */
export const withinBounds = (opts: {
  timestamp: string;
  after?: string;
  before?: string;
}) => {
  const at = Date.parse(opts.timestamp);

  if (opts.after && at < boundaryMs({ value: opts.after, edge: "start" }))
    return false;

  if (opts.before && at > boundaryMs({ value: opts.before, edge: "end" }))
    return false;

  return true;
};

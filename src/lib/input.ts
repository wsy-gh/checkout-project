import type { Surface } from "@/checkout/types";

/**
 * TURNING UNTRUSTED VALUES INTO TRUSTED ONES
 *
 * Everything arriving from outside — a JSON body, a query string, a form field — is `unknown`
 * until something checks it. TypeScript cannot help: it describes what a value is *supposed*
 * to be, and a cast like `body as CompleteInput` is a promise, not a check. The compiler
 * believes it and the runtime gets whatever the client actually sent.
 *
 * That is not hypothetical here. `surface` used to be cast rather than checked, so
 * `?surface=<script>x</script>` was written straight into the session and the event log.
 * These three functions are the fix, and the rule they enforce is:
 *
 *     Never coerce. Recognise, or return undefined.
 *
 * `String(["L1"])` is `"L1"` and `Number(true)` is `1`. Coercion invents plausible answers
 * from values that were never valid, so a bad request becomes a successful one instead of a
 * 400. Every function below asks "is this the type I wanted?" and gives up if not, leaving
 * the caller to decide between a default and a rejection.
 */

/**
 * A value that genuinely is a string.
 *
 * `["L1"]` is not `"L1"` and `123` is not `"123"` — both return undefined. `maxLength` exists
 * because a string from a stranger has no natural size: an idempotency key is stored on the
 * session for the session's lifetime, so a caller sending a megabyte of them is a slow memory
 * leak with a 200 response.
 */
export function asString(value: unknown, maxLength = 256): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;
}

/**
 * A finite number, or a string that spells one.
 *
 * Strings are accepted because HTML forms have no other way to send a number — the quantity
 * `<select>` submits `"2"`, not `2`. Nothing else is: `true` is not 1, `[5]` is not 5, `{}` is
 * not NaN-and-therefore-fine, and `Infinity` is not a quantity.
 *
 * Returning undefined rather than NaN matters. NaN is falsy in some checks and slips through
 * comparisons — every comparison with NaN is false, so `available < quantity` silently passes
 * for a NaN quantity. Undefined has no such disguise.
 */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * One of the two surfaces this app has, or nothing.
 *
 * The single most important function in this file, because `surface` arrives from more places
 * than any other value: a query string on the checkout page, a query string on
 * `GET /api/sessions/:id`, a JSON field on two POST routes, and a hidden form input on every
 * Server Action. Every one of those calls this, so there is exactly one definition of what
 * counts as a surface.
 *
 * Callers treat an unrecognised value as *absent* rather than as an error. The field is
 * telemetry and a choice of wording — never authority — so a typo in a link should render the
 * default surface, not a 400 in the middle of someone's checkout.
 */
export function asSurface(value: unknown): Surface | undefined {
  return value === "web" || value === "mobile" ? value : undefined;
}

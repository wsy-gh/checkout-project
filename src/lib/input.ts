import type { Surface } from "@/checkout/types";

/**
 * TURNING UNTRUSTED VALUES INTO TRUSTED ONES
 *
 * Since everything arriving from outside — a JSON body, a query string, a form field — is
 * `unknown` until something actually checks it, and TypeScript cannot do that checking for us
 * (a cast like `body as CompleteInput` is a promise made to the compiler, not a question asked
 * of the value, so the compiler believes it and the runtime still gets whatever the client
 * sent), the app needs a small set of functions that inspect a value at runtime and hand it
 * back only if it is really the type wanted. That need is not hypothetical: `surface` used to
 * be cast rather than checked, so `?surface=<script>x</script>` was written straight into the
 * session and the event log.
 *
 * The three functions below are the fix, and they are all implemented on one rule — never
 * coerce; recognise, or return undefined — for the following reason. `String(["L1"])` is
 * `"L1"` and `Number(true)` is `1`, so coercion invents a plausible answer from a value that
 * was never valid, turning a request that should be a 400 into a successful one. Each function
 * instead asks "is this the type I wanted?" and gives up if not, leaving the caller to choose
 * between a default and a rejection.
 */

/**
 * A value that genuinely is a string.
 *
 * Since `["L1"]` is not `"L1"` and `123` is not `"123"`, this returns undefined for anything
 * that is not already a string. It also takes a `maxLength`, because a string from a stranger
 * has no natural size and at least one of these — an idempotency key — is stored on the session
 * for the whole of the session's life, so without a cap a caller sending a megabyte of them
 * would be a slow memory leak that still answered 200.
 */
export function asString(value: unknown, maxLength = 256): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;
}

/**
 * A finite number, or a string that spells one.
 *
 * Since HTML forms have no way to send a real number — the quantity `<select>` submits the
 * string `"2"`, not `2` — this needs to accept a numeric string as well as a number, but
 * nothing looser than that: `true` is not 1, `[5]` is not 5, `{}` is not a quantity, and
 * `Infinity` is not either. It returns undefined rather than NaN on failure for a specific
 * reason: NaN is falsy in some checks and slips through comparisons — every comparison with NaN
 * is false, so a NaN quantity would pass `available < quantity` silently — whereas undefined
 * has no such disguise and forces the caller to handle the miss.
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
 * Since `surface` arrives from more places than any other value — a query string on the
 * checkout page, a query string on `GET /api/sessions/:id`, a JSON field on two POST routes,
 * and a hidden form input on every Server Action — it needs one definition of what counts as a
 * valid surface, so every one of those places calls this rather than each casting on its own.
 * An unrecognised value comes back as undefined and callers treat that as *absent* rather than
 * as an error, because `surface` is telemetry and a choice of wording and never authority, so a
 * typo in a link should render the default surface, not a 400 in the middle of someone's
 * checkout.
 */
export function asSurface(value: unknown): Surface | undefined {
  return value === "web" || value === "mobile" ? value : undefined;
}

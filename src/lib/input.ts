import type { Surface } from "@/checkout/types";

/**
 * Runtime checks for values arriving from outside — JSON bodies, query strings, form fields.
 * A cast like `body as CompleteInput` is a promise to the compiler, not a question asked of the
 * value, so the runtime still gets whatever the client sent; `surface` was once cast rather than
 * checked, and `?surface=<script>x</script>` was written straight into the session.
 *
 * All three follow one rule: recognise, never coerce. `String(["L1"])` is `"L1"` and
 * `Number(true)` is `1`, so coercion invents a valid-looking answer from an invalid value and
 * turns what should be a 400 into a success.
 */

/**
 * `maxLength` because a string from a stranger has no natural size, and one of these — an
 * idempotency key — is stored for the session's whole life, so an uncapped one is a slow leak
 * that still answers 200.
 */
export function asString(value: unknown, maxLength = 256): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;
}

/**
 * A finite number, or a string that spells one — HTML forms cannot send a real number, so the
 * quantity `<select>` submits `"2"`. Nothing looser: `true` is not 1 and `[5]` is not 5.
 *
 * Returns undefined rather than NaN, because every comparison with NaN is false, so a NaN
 * quantity would slip through `available < quantity` unnoticed.
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
 * `surface` arrives from query strings, JSON bodies and hidden form inputs, so it needs one
 * definition rather than a cast at each. An unrecognised value returns undefined and callers
 * treat it as absent rather than an error: surface chooses wording and telemetry, never
 * authority, so a typo in a link should render the default, not a 400 mid-checkout.
 */
export function asSurface(value: unknown): Surface | undefined {
  return value === "web" || value === "mobile" ? value : undefined;
}

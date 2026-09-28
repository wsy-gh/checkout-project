/**
 * MONEY FORMATTING
 *
 * Since JavaScript's floating-point problems (`0.1 + 0.2 !== 0.3`) would corrupt prices if we
 * let them, the real defence is upstream of this file: money is stored and computed as integer
 * cents everywhere, and `total * quantity` is integer times integer, so nothing is ever a
 * fraction until it is time to draw it on screen. This function is that one moment, and the
 * single division in the whole app.
 *
 * Since that division could in principle round a cent the wrong way, it is worth confirming
 * rather than assuming it is exact, and a test in tests/format.test.ts does exactly that,
 * checking the cent values around the boundaries where the rounding could go wrong. It holds
 * because an integer below 2^53 divided by 100 lands within one rounding step of the true
 * value and formatting to exactly two decimals closes that gap; amounts large enough to break
 * it are far outside anything a ticket order can produce.
 *
 * Two deliberate choices, each for a reason:
 *
 *   1. It uses `Intl.NumberFormat` rather than `toFixed(2)`, because hand-rolling produced
 *      `$1234.00` with no thousands separator and would have to be redone for any other
 *      currency.
 *   2. The locale is pinned to `en-US` rather than left to the runtime default, because the
 *      default would format with Node's locale on the server and the visitor's in the browser —
 *      the same number rendered two different ways across a hydration boundary. How prices are
 *      printed is a product decision, not a device setting, so it must not vary by who is
 *      looking.
 */
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export const money = (cents: number) => USD.format(cents / 100);

/**
 * TURN A LENGTH OF TIME INTO SOMETHING READABLE: "6h", "1h 30m", "25 min", "45s".
 *
 * Since a raw minute count reads badly at both ends ("starts in 349 min" is noise), this needs
 * to get coarser as the number gets bigger, and it is written to show seconds only under a
 * minute, where they are the part that actually matters. It takes a plain length and never a
 * direction, for the following reason: the same function then serves both "starts in 25 min"
 * and "started 25 min ago" with the caller supplying the wording, which is how
 * src/app/_components/EventTime.tsx uses it.
 */
export function duration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes} min`;
  return `${totalSeconds}s`;
}

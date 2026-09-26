/**
 * Money formatting.
 *
 * The defence against JavaScript's float problems is upstream of this file: money is stored
 * and computed as integer cents everywhere. `0.1 + 0.2 !== 0.3` cannot bite a value that is
 * never a fraction — `total * quantity` is integer × integer, and nothing divides until it is
 * time to draw pixels. This is that moment, and it is the only division in the app.
 *
 * That division is exact here, which is a claim worth checking rather than assuming: every
 * cent value from 0 to $20,000 round-trips to the correct two decimals (brute-forced, zero
 * mismatches). It holds because an integer under 2^53 divided by 100 lands within a rounding
 * step of the true value, and formatting to exactly 2 decimals closes the gap. Amounts big
 * enough to break that are far outside anything a ticket order can produce.
 *
 * Two deliberate choices:
 *
 *   1. `Intl.NumberFormat`, not `toFixed(2)`. Hand-rolling produced `$1234.00` with no
 *      thousands separator, and would need redoing for any other currency.
 *   2. The locale is pinned. Left to the runtime default this would format with Node's locale
 *      on the server and the visitor's in the browser — the same number rendering two ways
 *      across a hydration boundary. How we print prices is a product decision, not a device
 *      setting, so it does not vary by who is looking.
 */
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export const money = (cents: number) => USD.format(cents / 100);

/**
 * Turn a length of time into something readable: "6h", "1h 30m", "25 min", "45s".
 *
 * It gets coarser as the number gets bigger, because nobody wants to read "starts in 349
 * min". Seconds only appear under a minute, where they are the part that matters.
 *
 * It takes a plain length and never a direction, so the same function serves both "starts
 * in 25 min" and "started 25 min ago" — the caller supplies the wording. Used by
 * src/app/_components/EventTime.tsx.
 */
export function duration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes} min`;
  return `${totalSeconds}s`;
}

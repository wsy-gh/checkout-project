/**
 * Money is stored and computed as integer cents everywhere, so this division is the only one in
 * the app and the only place a price becomes fractional.
 *
 * The locale is pinned rather than left to the runtime default: the default formats with Node's
 * locale on the server and the visitor's in the browser, rendering the same number two ways
 * across a hydration boundary. `Intl` rather than `toFixed(2)`, which omits thousands separators.
 */
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export const money = (cents: number) => USD.format(cents / 100);

/**
 * A length of time as "6h", "1h 30m", "25 min" or "45s" — coarser as it gets longer, since
 * "starts in 349 min" reads as noise. Takes a length and never a direction, so the same function
 * serves both "starts in 25 min" and "started 25 min ago" with the caller supplying the wording.
 */
export function duration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes} min`;
  return `${totalSeconds}s`;
}

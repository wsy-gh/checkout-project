import type { Surface } from "@/checkout/types";

/**
 * THE ONE PLACE A CHECKOUT URL IS BUILT
 *
 * There is a single checkout route, `/checkout/:id`, and the surface is a query parameter on
 * it. An earlier version had two routes — `/checkout/:id` and `/m/checkout/:id` — which were
 * two nearly identical page files differing in a CSS wrapper and a wording flag. One route
 * with a parameter says the same thing with one file, and makes the claim literal rather than
 * structural: there is one page, and `surface` only decides how it is dressed.
 *
 * `surface=web` is left off entirely, because it is the default and a URL should not carry
 * information it does not need. An unrecognised value resolves back to web when the page reads
 * it (see `asSurface`), so a mangled link degrades to the ordinary checkout rather than to an
 * error.
 *
 *
 * WHY THE ID IS ENCODED HERE
 *
 * Because one caller of this function is `/deeplink/:id`, which exists to be handed links by
 * strangers. It used to interpolate the id straight into a redirect, so
 * `/deeplink/..%2F..%2F..%2Fetc%2Fpasswd` redirected to `/etc/passwd` — the id escaped the
 * path segment it was supposed to fill. Encoding turns any such value back into a single
 * literal segment, which then simply fails to match a session and renders "we couldn't find
 * that checkout", which is the truth.
 *
 * Doing it in the builder rather than at each call site means no future caller has to
 * remember.
 */
export function checkoutPath(id: string, surface: Surface, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  if (surface === "mobile") params.set("surface", "mobile");
  const query = params.toString();
  return `/checkout/${encodeURIComponent(id)}${query ? `?${query}` : ""}`;
}

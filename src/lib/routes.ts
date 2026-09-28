import type { Surface } from "@/checkout/types";

/**
 * THE ONE PLACE A CHECKOUT URL IS BUILT
 *
 * Since there is a single checkout route, `/checkout/:id`, with the surface carried as a query
 * parameter, several places need to build that URL correctly and consistently, so this is the
 * one function they all go through. It is a single route rather than two — an earlier version
 * had `/checkout/:id` and `/m/checkout/:id`, two nearly identical page files differing only in
 * a CSS wrapper and a wording flag — for the following reason: one route with a parameter says
 * the same thing in one file and makes the project's claim literal rather than structural,
 * namely that there is one page and `surface` only decides how it is dressed.
 *
 * Since `web` is the default surface, it is left off the URL entirely, because a URL should not
 * carry information it does not need; and since the page resolves an unrecognised surface back
 * to `web` when it reads it (see `asSurface`), a mangled link degrades to the ordinary checkout
 * page rather than to an error.
 *
 * WHY THE ID IS ENCODED
 *
 * Since one caller of this function is `/deeplink/:id`, whose entire purpose is receiving links
 * from strangers, the id must be encoded so it cannot escape the path segment it is meant to
 * fill. It was not always: an earlier version interpolated the id straight into a redirect, so
 * `/deeplink/..%2F..%2F..%2Fetc%2Fpasswd` redirected to `/etc/passwd`. `encodeURIComponent`
 * turns any such value back into one literal segment, which then simply matches no session and
 * renders "we couldn't find that checkout" — the truth. It is done here in the builder rather
 * than at each call site so that no future caller has to remember to do it.
 */
export function checkoutPath(id: string, surface: Surface, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  if (surface === "mobile") params.set("surface", "mobile");
  const query = params.toString();
  return `/checkout/${encodeURIComponent(id)}${query ? `?${query}` : ""}`;
}

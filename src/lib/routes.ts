import type { Surface } from "@/checkout/types";

/**
 * The one place a checkout URL is built. There is a single checkout route with the surface as a
 * query parameter, so `web` — the default — is left off the URL entirely, and a mangled surface
 * resolves back to `web` when the page reads it (see `asSurface`) rather than erroring.
 *
 * The id is encoded here rather than at each call site because one caller is `/deeplink/:id`,
 * which receives links from strangers: an unencoded id can escape its path segment, and an
 * earlier version let `/deeplink/..%2F..%2F..%2Fetc%2Fpasswd` redirect to `/etc/passwd`.
 */
export function checkoutPath(id: string, surface: Surface, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  if (surface === "mobile") params.set("surface", "mobile");
  const query = params.toString();
  return `/checkout/${encodeURIComponent(id)}${query ? `?${query}` : ""}`;
}

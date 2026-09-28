import { redirect } from "next/navigation";
import { checkoutPath } from "@/lib/routes";

/**
 * STANDS IN FOR THE LINK THAT WOULD OPEN THE NATIVE APP.
 *
 * In a real product this would be a universal link — tap it on a phone and the app opens on the
 * checkout screen, or the website handles it if the app is not installed. Here it simply redirects
 * to the checkout page in its mobile presentation, which is enough to show the part that matters.
 *
 * And the part that matters is what the link contains: an ID, and nothing else — no price, no expiry,
 * no seat details. Since all of those would be stale by the time anyone tapped the link, and a link a
 * stranger could edit is not something to take instructions from, the receiving page asks the server
 * and finds out the truth for itself.
 *
 * Since this route exists to be handed links by strangers, the ID goes through `checkoutPath` (which
 * encodes it) rather than into a template string. It used to interpolate directly, so
 * `/deeplink/..%2F..%2F..%2Fetc%2Fpasswd` redirected to `/etc/passwd`, the ID escaping the path
 * segment it was meant to fill. Encoded, any such value is one literal segment that matches no
 * session, and the fan gets "we couldn't find that checkout", which is true.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(checkoutPath(id, "mobile"));
}

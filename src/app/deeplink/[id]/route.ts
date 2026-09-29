import { redirect } from "next/navigation";
import { checkoutPath } from "@/lib/routes";

/**
 * Stands in for the universal link that would open the native app on the checkout screen. Here it
 * just redirects to the checkout page in its mobile presentation.
 *
 * What matters is that the link carries an id and nothing else — no price, no expiry, no seat
 * count. All of those would be stale by the time anyone tapped it, and a link a stranger can edit
 * is not a source of truth, so the receiving page asks the server instead. The id goes through
 * `checkoutPath`, which encodes it; interpolating it directly once let
 * `/deeplink/..%2F..%2F..%2Fetc%2Fpasswd` redirect to `/etc/passwd`.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(checkoutPath(id, "mobile"));
}

import { checkout } from "@/lib/checkout";
import { asSurface } from "@/lib/input";
import { respond } from "@/lib/respond";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/sessions/:id?surface=web|mobile
 *
 * The whole of "resume": a device asks about an id and gets the session back — no handshake, no
 * syncing, nothing transferred between devices. Reading is also when a session catches up with
 * reality, which all lives in `get`.
 *
 * `surface` is analytics only and never changes what comes back, but it is checked rather than cast:
 * it used to be cast, and `?surface=<script>x</script>` was written straight into `lastSeenOn` and
 * the event log. Unrecognised now means absent, since a typo in a link should not be a 400
 * mid-checkout.
 */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const surface = asSurface(new URL(req.url).searchParams.get("surface"));
  return respond(() => checkout.get(id, surface));
}

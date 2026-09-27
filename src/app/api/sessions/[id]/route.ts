import { checkout } from "@/lib/checkout";
import { asSurface } from "@/lib/input";
import { respond } from "@/lib/respond";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/sessions/:id?surface=web|mobile
 *
 * This is "resume", and there is nothing else to it — a device asks about an ID and gets the
 * session back. No handshake, no syncing, no state transferred between devices.
 *
 * Reading is also when a session catches up with reality: a lapsed hold becomes expired, a
 * pulled listing becomes a failure, and a payment that was in flight gets checked with the
 * provider. All of that lives in `get` in src/checkout/service.ts.
 *
 * `surface` is analytics only. It records which kind of device looked, and never changes what
 * comes back — but it is still checked rather than cast, which it previously was not. A cast
 * is a promise to the compiler, not a question to the value, so `?surface=<script>x</script>`
 * was written straight into `session.lastSeenOn` and the event log. Anything unrecognised is
 * now treated as absent, which is right for a field that is telemetry: a typo in a link should
 * not be a 400 in the middle of someone's checkout.
 */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const surface = asSurface(new URL(req.url).searchParams.get("surface"));
  return respond(() => checkout.get(id, surface));
}

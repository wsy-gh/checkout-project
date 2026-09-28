import { checkout } from "@/lib/checkout";
import { asSurface } from "@/lib/input";
import { respond } from "@/lib/respond";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/sessions/:id?surface=web|mobile
 *
 * Since resuming a checkout is nothing more than reading it, this endpoint is the whole of
 * "resume": a device asks about an ID and gets the session back — no handshake, no syncing, no
 * state transferred between devices. Reading is also when a session catches up with reality (a
 * lapsed hold becomes expired, a pulled listing becomes a failure, a payment in flight gets checked
 * with the provider), all of which lives in `get` in src/checkout/service.ts.
 *
 * `surface` is analytics only — it records which kind of device looked and never changes what comes
 * back — but it is checked rather than cast, which it previously was not. Since a cast is a promise
 * to the compiler and not a question to the value, `?surface=<script>x</script>` used to be written
 * straight into `session.lastSeenOn` and the event log; anything unrecognised is now treated as
 * absent, which is right for a telemetry field, because a typo in a link should not be a 400 in the
 * middle of someone's checkout.
 */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const surface = asSurface(new URL(req.url).searchParams.get("surface"));
  return respond(() => checkout.get(id, surface));
}

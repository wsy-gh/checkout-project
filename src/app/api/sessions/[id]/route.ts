import type { Surface } from "@/checkout/types";
import { checkout } from "@/lib/checkout";
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
 * `surface` is analytics only. It records which kind of device looked, and never changes
 * what comes back.
 */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const surface = new URL(req.url).searchParams.get("surface") as Surface | null;
  return respond(() => checkout.get(id, surface ?? undefined));
}

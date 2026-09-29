import { checkout } from "@/lib/checkout";
import { respond } from "@/lib/respond";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/sessions/:id/cancel → EXPIRED, seats back immediately (only from ACTIVE).
 *
 * Takes no `version`. The status check inside `cancel` already refuses once a charge has started,
 * which is the case that matters; refusing a release because the screen was stale would only stop a
 * fan from giving up seats they have decided not to buy.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return respond(() => checkout.cancel(id));
}

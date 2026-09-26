import type { Surface } from "@/checkout/types";
import { checkout } from "@/lib/checkout";
import { respond } from "@/lib/respond";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/sessions/:id?surface=web|mobile → session + serverNow + priceChange?
 * This is "resume". It reconciles expiry, withdrawal and pending payment on read.
 */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const surface = new URL(req.url).searchParams.get("surface") as Surface | null;
  return respond(() => checkout.get(id, surface ?? undefined));
}

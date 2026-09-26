import type { AcceptPriceInput } from "@/checkout/types";
import { checkout } from "@/lib/checkout";
import { readJson, respond } from "@/lib/respond";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/sessions/:id/accept-price  { version, priceVersion, surface? } */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = await readJson<AcceptPriceInput>(req);
  return respond(() => checkout.acceptPrice(id, { ...body, version: Number(body.version), priceVersion: Number(body.priceVersion) }));
}

import { checkout } from "@/lib/checkout";
import { asNumber, asSurface } from "@/lib/input";
import { readJson, respond } from "@/lib/respond";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/sessions/:id/accept-price  { version, priceVersion, surface? }
 *
 * The three fields are named explicitly rather than spread from the body, which would be mass
 * assignment: safe only for as long as the domain happens to ignore the extra keys, and one added
 * field away from being settable by anyone who guesses its name.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  return respond(async () => {
    const body = await readJson<Record<string, unknown>>(req);
    return checkout.acceptPrice(id, {
      version: asNumber(body.version) ?? NaN,
      priceVersion: asNumber(body.priceVersion) ?? NaN,
      surface: asSurface(body.surface),
    });
  });
}

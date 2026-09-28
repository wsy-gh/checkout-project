import { checkout } from "@/lib/checkout";
import { asNumber, asSurface } from "@/lib/input";
import { readJson, respond } from "@/lib/respond";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/sessions/:id/accept-price  { version, priceVersion, surface? }
 *
 * Since `{ ...body }` would be mass assignment — forwarding every key a caller chose to send into
 * the domain input, harmless only for as long as the domain happened to ignore the extras — the
 * three fields are named explicitly instead. That way, adding a field to the input type can never
 * silently make it settable by anyone who guesses its name.
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

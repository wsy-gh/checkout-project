import { checkout } from "@/lib/checkout";
import { asNumber, asSurface } from "@/lib/input";
import { readJson, respond } from "@/lib/respond";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/sessions/:id/accept-price  { version, priceVersion, surface? }
 *
 * The three fields are named explicitly rather than spread from the body. `{ ...body }` was
 * mass assignment: it forwarded every key a caller chose to send into the domain input, which
 * was harmless only for as long as the domain happened to ignore the extras. Listing the
 * fields means adding one to the input type can never silently make it settable by anyone.
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

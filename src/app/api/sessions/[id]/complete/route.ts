import { checkout } from "@/lib/checkout";
import { asNumber, asString, asSurface } from "@/lib/input";
import { readJson, respond } from "@/lib/respond";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/sessions/:id/complete — pay. The body carries four things that all matter:
 *
 *   version         which version of the session this device was looking at
 *   priceVersion    which price it is agreeing to
 *   idempotencyKey  identifies this attempt, so a retry is not a second charge
 *   paymentToken    stands in for the provider's card token; never stored on the session
 *
 * The rules they feed are in `complete`. Nothing here coerces, so a missing or nonsense version
 * arrives as NaN, every comparison with NaN is false, and a garbled request fails *closed* on
 * STALE_VERSION without reaching a charge. The key and token pass through for the domain to
 * validate, because `String(...)` on them was itself the bug: it turned `{}` into the literal key
 * "[object Object]", shared by every such caller.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  return respond(async () => {
    const body = await readJson<Record<string, unknown>>(req);
    return checkout.complete(id, {
      version: asNumber(body.version) ?? NaN,
      priceVersion: asNumber(body.priceVersion) ?? NaN,
      idempotencyKey: asString(body.idempotencyKey, 200) ?? "",
      paymentToken: asString(body.paymentToken) ?? "",
      surface: asSurface(body.surface),
    });
  });
}

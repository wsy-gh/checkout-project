import { checkout } from "@/lib/checkout";
import { asNumber, asString, asSurface } from "@/lib/input";
import { readJson, respond } from "@/lib/respond";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/sessions/:id/complete
 *
 * Pay. The body carries four things that all matter:
 *
 *   version         which version of the session this device was looking at
 *   priceVersion    which price it is agreeing to
 *   idempotencyKey  identifies this attempt, so a retry is not a second charge
 *   paymentToken    a stand-in for the provider's card token; never stored on the session
 *
 * The rules those feed are all in `complete` in src/checkout/service.ts, which is the file
 * to read if you want to know how two devices pressing Pay at once is handled.
 *
 * Nothing here coerces. The two version numbers arrive as `NaN` when they are missing or
 * nonsense, and every comparison against NaN is false — so a garbled request fails *closed*,
 * on `STALE_VERSION`, and never reaches a charge. The key and the token are passed through
 * as-is for the domain to validate, because `String(...)` on them was the bug: it turned
 * `{}` into the literal key `"[object Object]"`, which every such caller then shared.
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

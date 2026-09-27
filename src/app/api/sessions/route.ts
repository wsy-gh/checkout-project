import { CheckoutError } from "@/checkout/types";
import { checkout, holdLimiter } from "@/lib/checkout";
import { asNumber, asString, asSurface } from "@/lib/input";
import { callerKey } from "@/lib/rate-limit";
import { readJson, respond } from "@/lib/respond";

/**
 * POST /api/sessions  { listingId, quantity, surface } → 201 session
 *
 * The only endpoint that takes seats off the market, which makes it the only one worth rate
 * limiting: everything else either reads, or acts on a hold the caller already has. See
 * src/lib/rate-limit.ts for what that does and does not protect against.
 *
 * Every field is recognised rather than coerced (src/lib/input.ts). `String(["L1"])` is
 * `"L1"` and `Number(true)` is `1`, so coercion turns values that were never valid into
 * successful requests; `asString`/`asNumber` hand back undefined instead and let the domain
 * refuse. The domain is also where `listingId` and `quantity` are validated, because this
 * route is only one of the two front doors — the Server Action in src/app/actions.ts is the
 * other, and a rule enforced in one doorway is not really enforced.
 */
export async function POST(req: Request) {
  const res = await respond(async () => {
    if (!holdLimiter.take(callerKey(req))) throw new CheckoutError("RATE_LIMITED");
    const body = await readJson<Record<string, unknown>>(req);
    return checkout.create({
      listingId: asString(body.listingId) ?? "",
      // Absent means one ticket. Present means exactly what was sent: `NaN` for anything that
      // is not a number, which the domain rejects rather than rounding into a purchase.
      quantity: body.quantity === undefined ? 1 : (asNumber(body.quantity) ?? NaN),
      surface: asSurface(body.surface) ?? "web",
    });
  });
  return res.ok ? new Response(res.body, { status: 201, headers: res.headers }) : res;
}

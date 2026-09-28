import { checkout } from "@/lib/checkout";
import { asNumber, asString, asSurface } from "@/lib/input";
import { readJson, respond } from "@/lib/respond";

/**
 * POST /api/sessions  { listingId, quantity, surface } → 201 session
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

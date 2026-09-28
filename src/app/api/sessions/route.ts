import { checkout } from "@/lib/checkout";
import { clientIdFromRequest } from "@/lib/client-id";
import { asNumber, asString, asSurface } from "@/lib/input";
import { readJson, respond } from "@/lib/respond";

/**
 * POST /api/sessions  { listingId, quantity, surface } → 201 session
 *
 * Since coercion turns values that were never valid into successful requests — `String(["L1"])` is
 * `"L1"` and `Number(true)` is `1` — every field is recognised rather than coerced (src/lib/input.ts):
 * `asString`/`asNumber` hand back undefined instead, and the domain refuses. The shape checks for
 * `listingId` and `quantity` live in the domain rather than here, because this route is only one of
 * the two front doors — the Server Action in src/app/actions.ts is the other — and a rule enforced
 * in just one doorway is not really enforced.
 */
export async function POST(req: Request) {
  const res = await respond(async () => {
    const body = await readJson<Record<string, unknown>>(req);
    return checkout.create({
      listingId: asString(body.listingId) ?? "",
      // An absent quantity means one ticket; a present one is used exactly as sent — `NaN` for
      // anything that is not a number, which the domain rejects rather than rounding into a purchase.
      quantity: body.quantity === undefined ? 1 : (asNumber(body.quantity) ?? NaN),
      surface: asSurface(body.surface) ?? "web",
      // If a browser reaches the API with a `cid` cookie it gets the same per-listing hold dedup the
      // Server Action provides; a cookie-less caller (curl) just gets undefined and no dedup. The API
      // reads the header directly rather than minting a cookie — see src/lib/client-id.ts.
      clientId: clientIdFromRequest(req),
    });
  });
  return res.ok ? new Response(res.body, { status: 201, headers: res.headers }) : res;
}

import { checkout } from "@/lib/checkout";
import { clientIdFromRequest } from "@/lib/client-id";
import { asNumber, asString, asSurface } from "@/lib/input";
import { readJson, respond } from "@/lib/respond";

/**
 * POST /api/sessions  { listingId, quantity, surface } → 201 session
 *
 * Fields are recognised rather than coerced (see input.ts), so an invalid value becomes undefined
 * and the domain refuses instead of a nonsense request succeeding. The shape checks live in the
 * domain rather than here, because this route is only one of the two front doors.
 */
export async function POST(req: Request) {
  const res = await respond(async () => {
    const body = await readJson<Record<string, unknown>>(req);
    return checkout.create({
      listingId: asString(body.listingId) ?? "",
      // Absent means one ticket. A present value is used exactly as sent — NaN for anything that is
      // not a number, which the domain rejects rather than rounding into a purchase.
      quantity: body.quantity === undefined ? 1 : (asNumber(body.quantity) ?? NaN),
      surface: asSurface(body.surface) ?? "web",
      // A browser reaching the API with a `cid` gets the same dedup the Server Action provides; a
      // cookie-less caller gets undefined and none. Read from the header rather than minted here.
      clientId: clientIdFromRequest(req),
    });
  });
  return res.ok ? new Response(res.body, { status: 201, headers: res.headers }) : res;
}

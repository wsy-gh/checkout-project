import type { CreateInput } from "@/checkout/types";
import { checkout } from "@/lib/checkout";
import { readJson, respond } from "@/lib/respond";

/** POST /api/sessions  { listingId, quantity, surface } → 201 session */
export async function POST(req: Request) {
  const body = await readJson<Partial<CreateInput>>(req);
  const res = await respond(() =>
    checkout.create({
      listingId: String(body.listingId ?? ""),
      // An absent quantity means one ticket. A quantity that is *present* is used exactly as
      // sent — no clamping, and no coercing a bad value into a good one. `Math.max(1, NaN)`
      // is NaN, and NaN slips past `available < quantity` because every comparison with NaN
      // is false, so a clamp here once corrupted the seat counter.
      //
      // `?? 1` used to cover both cases, which quietly made `{"quantity": null}` a purchase
      // of one ticket. Absent and null are not the same thing: one is a client leaving a
      // default alone, the other is a client sending a value that is not a quantity. Only the
      // first gets a default. `Number(null)` is 0, which the domain refuses.
      quantity: body.quantity === undefined ? 1 : Number(body.quantity),
      surface: body.surface === "mobile" ? "mobile" : "web",
    }),
  );
  return res.ok ? new Response(res.body, { status: 201, headers: res.headers }) : res;
}

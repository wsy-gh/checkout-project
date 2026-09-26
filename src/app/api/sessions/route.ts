import type { CreateInput } from "@/checkout/types";
import { checkout } from "@/lib/checkout";
import { readJson, respond } from "@/lib/respond";

/** POST /api/sessions  { listingId, quantity, surface } → 201 session */
export async function POST(req: Request) {
  const body = await readJson<Partial<CreateInput>>(req);
  const res = await respond(() =>
    checkout.create({
      listingId: String(body.listingId ?? ""),
      quantity: Math.max(1, Number(body.quantity ?? 1)),
      surface: body.surface === "mobile" ? "mobile" : "web",
    }),
  );
  return res.ok ? new Response(res.body, { status: 201, headers: res.headers }) : res;
}

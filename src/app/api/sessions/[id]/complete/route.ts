import type { CompleteInput } from "@/checkout/types";
import { checkout } from "@/lib/checkout";
import { readJson, respond } from "@/lib/respond";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/sessions/:id/complete  { version, priceVersion, idempotencyKey, paymentToken, surface? }
 * The client mints idempotencyKey once per attempt and reuses it on retry.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = await readJson<CompleteInput>(req);
  if (!body.idempotencyKey) return Response.json({ code: "BAD_REQUEST", message: "idempotencyKey required" }, { status: 400 });
  return respond(() =>
    checkout.complete(id, {
      version: Number(body.version),
      priceVersion: Number(body.priceVersion),
      idempotencyKey: String(body.idempotencyKey),
      paymentToken: String(body.paymentToken ?? "tok_test"),
      surface: body.surface,
    }),
  );
}

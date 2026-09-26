import type { CompleteInput } from "@/checkout/types";
import { checkout } from "@/lib/checkout";
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
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = await readJson<CompleteInput>(req);
  return respond(() =>
    checkout.complete(id, {
      version: Number(body.version),
      priceVersion: Number(body.priceVersion),
      idempotencyKey: String(body.idempotencyKey ?? ""), // empty → INVALID_REQUEST from the domain
      paymentToken: String(body.paymentToken ?? "tok_test"),
      surface: body.surface,
    }),
  );
}

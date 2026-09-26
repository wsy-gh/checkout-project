import { checkout, resetAll, stubs } from "@/lib/checkout";

type Ctx = { params: Promise<{ knob: string }> };

/**
 * Dev-only knobs so the demo and scripted scenarios can turn the world without a UI:
 *
 *   GET  /api/debug/events                     the structured event log
 *   GET  /api/debug/state                      listings + all sessions
 *   POST /api/debug/advance   {ms}             move the server clock forward
 *   POST /api/debug/price     {listingId,total} change a listing's price (bumps priceVersion)
 *   POST /api/debug/withdraw  {listingId}       seller delists
 *   POST /api/debug/restore   {listingId}
 *   POST /api/debug/payment   {next: ok|declined|unknown|lost, delayMs?}
 *   POST /api/debug/reset
 */
export async function GET(_req: Request, { params }: Ctx) {
  const { knob } = await params;
  if (knob === "events") return json(stubs.events.all());
  if (knob === "state")
    return json({ serverNow: stubs.clock.now(), listings: stubs.inventory.all(), sessions: checkout._all() });
  return json({ error: "unknown knob" }, 404);
}

export async function POST(req: Request, { params }: Ctx) {
  const { knob } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  switch (knob) {
    case "advance": stubs.clock.advance(Number(body.ms ?? 0)); break;
    case "price": stubs.pricing.setTotal(String(body.listingId), Number(body.total)); break;
    case "withdraw": stubs.inventory.withdraw(String(body.listingId)); break;
    case "restore": stubs.inventory.restore(String(body.listingId)); break;
    case "payment":
      stubs.payments.nextResult = body.next as typeof stubs.payments.nextResult;
      if (body.delayMs !== undefined) stubs.payments.delayMs = Number(body.delayMs);
      break;
    case "reset": resetAll(); break;
    default: return json({ error: "unknown knob" }, 404);
  }
  return json({ ok: true, serverNow: stubs.clock.now() });
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

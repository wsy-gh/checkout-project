import { checkout, resetAll, stubs } from "@/lib/checkout";

type Ctx = { params: Promise<{ knob: string }> };

/**
 * KNOBS FOR MAKING THINGS GO WRONG ON PURPOSE
 *
 * The hard cases in a checkout — a price moving while someone is away, a seller pulling a
 * listing, a payment provider timing out, a hold running out — are all things you cannot
 * wait around for. These routes reach into the stubs in src/checkout/stubs.ts and cause them
 * on demand, which is what makes the whole story demonstrable in scripts/demo.sh.
 *
 * None of this would ship, so `devOnly` below makes that structural rather than a promise in
 * a comment. A route that resets every session or moves the server's clock is not something
 * to leave reachable in a deployed app and trust nobody to find: it is unauthenticated, and
 * one POST wipes the state of every fan mid-checkout. In a production build both handlers
 * answer 404, which is also what an unknown route would say — there is nothing here to
 * discover. It exists because a reviewer should be able to see the interesting behaviour in a
 * minute rather than take it on trust.
 *
 * The check reads the environment on every call rather than once at module load, so a test
 * can set `NODE_ENV=production` and watch the door actually close. See tests/api.test.ts.
 *
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
/** In a production build these routes do not exist. */
const devOnly = () => (process.env.NODE_ENV === "production" ? json({ error: "not found" }, 404) : null);

export async function GET(_req: Request, { params }: Ctx) {
  const gone = devOnly();
  if (gone) return gone;
  const { knob } = await params;
  if (knob === "events") return json(stubs.events.all());
  if (knob === "state")
    return json({ serverNow: stubs.clock.now(), listings: stubs.inventory.all(), sessions: checkout._all() });
  return json({ error: "unknown knob" }, 404);
}

export async function POST(req: Request, { params }: Ctx) {
  const gone = devOnly();
  if (gone) return gone;
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

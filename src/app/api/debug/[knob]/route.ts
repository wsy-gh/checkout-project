import { checkout, instanceId, resetAll, stubs } from "@/lib/checkout";

type Ctx = { params: Promise<{ knob: string }> };

/**
 * Knobs that cause the hard cases on demand — a price moving, a seller delisting, a provider timing
 * out, a hold lapsing — by reaching into the stubs, which is what makes scripts/demo.sh able to show
 * the whole story in a minute.
 *
 * An unauthenticated route where one POST resets every session or moves the clock must not ship, so
 * that is structural rather than a promise: `devOnly` returns 404 from both handlers in a production
 * build, the same answer an unknown route gives, so there is nothing to discover. It reads the
 * environment per call rather than at module load, so a test can set NODE_ENV=production and watch
 * the door close.
 *
 *   GET  /api/debug/events                      the structured event log
 *   GET  /api/debug/state                       instance id + listings + all sessions
 *   POST /api/debug/advance   {ms}              move the server clock forward
 *   POST /api/debug/price     {listingId,total} change a listing's price (bumps priceVersion)
 *   POST /api/debug/withdraw  {listingId}       seller delists
 *   POST /api/debug/restore   {listingId}
 *   POST /api/debug/payment   {next: ok|declined|unknown|lost, delayMs?}
 *   POST /api/debug/reset
 */
const devOnly = () => (process.env.NODE_ENV === "production" ? json({ error: "not found" }, 404) : null);

export async function GET(_req: Request, { params }: Ctx) {
  const gone = devOnly();
  if (gone) return gone;
  const { knob } = await params;
  if (knob === "events") return json(stubs.events.all());
  if (knob === "state")
    return json({
      // Which process answered. Two requests reporting different values mean this deployment runs
      // more than one instance, each with its own sessions — which the cluster-worker check in
      // src/lib/checkout.ts cannot see on a serverless platform.
      instance: { id: instanceId, pid: process.pid },
      serverNow: stubs.clock.now(),
      listings: stubs.inventory.all(),
      sessions: checkout._all(),
    });
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

import { checkout, instanceId, resetAll, stubs } from "@/lib/checkout";

type Ctx = { params: Promise<{ knob: string }> };

/**
 * KNOBS FOR MAKING THINGS GO WRONG ON PURPOSE
 *
 * Since the hard cases in a checkout — a price moving while someone is away, a seller pulling a
 * listing, a provider timing out, a hold running out — are all things you cannot wait around for,
 * these routes reach into the stubs in src/checkout/stubs.ts and cause them on demand, which is what
 * makes the whole story demonstrable in scripts/demo.sh in about a minute rather than on trust.
 *
 * Since none of this would ever ship — an unauthenticated route where one POST resets every session
 * or moves the server's clock is not something to leave reachable and trust nobody to find — that is
 * made structural rather than a promise in a comment: `devOnly` below returns 404 from both handlers
 * in a production build, which is also what an unknown route would say, so there is nothing to
 * discover. It reads the environment on every call rather than once at module load, so a test can set
 * `NODE_ENV=production` and watch the door actually close. See tests/api.test.ts.
 *
 *
 *   GET  /api/debug/events                     the structured event log
 *   GET  /api/debug/state                      instance id + listings + all sessions
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
    return json({
      // Which process answered. Since every session lives in one process's memory, two requests
      // that ever report different values here mean this deployment is running more than one
      // instance and serving sessions from whichever one a request happened to reach.
      // src/lib/checkout.ts already refuses to start as a cluster worker; reporting the id here
      // catches the cases that check cannot see, such as a serverless platform running many
      // isolated instances.
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

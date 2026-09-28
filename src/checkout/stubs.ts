import type { Alternative, Deps, PaymentOutcome } from "./types";
import { v7 as uuidv7 } from "uuid";

/**
 * STAND-INS FOR EVERYTHING OUTSIDE THIS APP
 *
 * The state machine in service.ts needs a clock, an inventory system, a pricing service and
 * a payment provider. In production those are real systems; here they are the fake versions
 * below, all satisfying the `Deps` interface in types.ts.
 *
 * Two things make them worth reading rather than skipping:
 *
 * THE CLOCK IS A STUB TOO. Nothing anywhere in this app calls `Date.now()` directly. That is
 * what lets a test say "eleven minutes pass" instantly, and lets the demo fast-forward to a
 * hold running out without anybody waiting. A real deployment passes in a clock that just
 * reads the system time, and nothing else changes.
 *
 * EACH ONE HAS KNOBS. `payments.nextResult`, `pricing.setTotal`, `inventory.withdraw`,
 * `clock.advance` — these are how the hard cases get triggered on demand. The debug routes
 * in src/app/api/debug/ expose them over HTTP so scripts/demo.sh can drive the whole story
 * with curl. Being able to say "the next charge times out" in one line is the difference
 * between testing the interesting paths and hoping they work.
 *
 * Nothing here is clever, on purpose. These exist to make the real code testable.
 */

export type Listing = {
  id: string;
  eventName: string;
  section: string;
  available: number;
  /** Cents per ticket, fees included. */
  total: number;
  priceVersion: number;
  withdrawn: boolean;
  eventStartsAt: number;
  /** Sales stop this long before the event starts. */
  cutoffLeadMs: number;
};

const MIN = 60_000;

export function makeStubs(opts: { now?: number } = {}) {
  // Every piece of changeable state lives in this one object so that reset() can rebuild it
  // without replacing the stub objects around it. That matters because those stubs are held
  // on globalThis (see src/lib/checkout.ts) and other modules keep references to them —
  // swapping them out would leave half the app talking to an abandoned copy.
  const state = { t: 0, frozen: false, offset: 0, listings: new Map<string, Listing>(), intents: new Map<string, PaymentOutcome>() };

  function seed() {
    state.t = opts.now ?? Date.now();
    state.frozen = opts.now !== undefined;
    state.offset = 0;
    state.intents = new Map();
    const base = clock.now();
    state.listings = new Map(
      [
        { id: "L1", eventName: "Warriors vs Lakers", section: "Sec 118, Row 12", available: 4, total: 8900, eventStartsAt: base + 90 * MIN },
        { id: "L2", eventName: "Giants vs Dodgers", section: "Club Level 214", available: 2, total: 6400, eventStartsAt: base + 25 * MIN },
        { id: "L3", eventName: "Sharks vs Kings", section: "Sec 209", available: 1, total: 4200, eventStartsAt: base + 6 * 60 * MIN },
      ].map((l) => [l.id, { ...l, priceVersion: 1, withdrawn: false, cutoffLeadMs: 5 * MIN }]),
    );
  }

  // ---- clock: manual, so tests and the demo can jump forward ----
  const clock = {
    now: () => (state.frozen ? state.t : Date.now() + state.offset),
    advance(ms: number) {
      if (state.frozen) state.t += ms;
      else state.offset += ms;
    },
    freeze(at: number) { state.frozen = true; state.t = at; },
  };

  // ---- ids ----
  //
  // A prefix so a value is recognisable at a glance, then a UUIDv7.
  //
  // These were `cs_0001`, `cs_0002` — which made the demo wonderfully readable and the whole
  // store walkable by counting. Since the link is the only credential a session has (there is
  // no auth), a guessable ID is not a small problem: it is the difference between "you need
  // the link" and "you need to be able to count".
  //
  // v7 rather than v4 because it begins with a millisecond timestamp, so IDs sort by when they
  // were minted. Against a real database that keeps inserts at one end of the index instead of
  // scattered through it; here it just means `_all()` comes back in a sensible order. The 74
  // random bits are what make it unguessable. The timestamp is taken from the injected clock,
  // not `Date.now()`, so a test that fast-forwards produces IDs consistent with its own timeline.
  const ids = { next: (prefix: string) => `${prefix}_${uuidv7({ msecs: clock.now() })}` };

  seed();

  // ---- inventory + pricing share the listing table ----
  const listings = { get: (id: string) => state.listings.get(id), has: (id: string) => state.listings.has(id), values: () => state.listings.values() };
  const need = (id: string) => {
    const l = listings.get(id);
    if (!l) throw new Error(`unknown listing ${id}`);
    return l;
  };

  const inventory = {
    hold(id: string, qty: number) {
      const l = need(id);
      if (l.withdrawn || l.available < qty) return false;
      l.available -= qty;
      return true;
    },
    release(id: string, qty: number) { need(id).available += qty; },
    backs: (id: string) => listings.has(id) && !need(id).withdrawn,
    salesCutoff: (id: string) => need(id).eventStartsAt - need(id).cutoffLeadMs,
    /**
     * What else the fan could buy, if their listing disappears.
     *
     * Picking genuinely comparable tickets is a real ranking problem in production. Here it
     * is "any other listing that still exists and has seats", which is enough to make the
     * point: a fan whose seats vanished should never be left staring at a dead end.
     */
    alternatives: (id: string): Alternative[] =>
      [...listings.values()]
        .filter((l) => l.id !== id && !l.withdrawn && l.available > 0)
        .map((l) => ({ id: l.id, eventName: l.eventName, section: l.section, total: l.total })),
    // knobs
    withdraw(id: string) { need(id).withdrawn = true; },
    restore(id: string) { need(id).withdrawn = false; },
    all: () => [...listings.values()],
    get: need,
  };

  const pricing = {
    current: (id: string) => ({ total: need(id).total, version: need(id).priceVersion }),
    // knob
    setTotal(id: string, total: number) {
      const l = need(id);
      l.total = total;
      l.priceVersion += 1;
    },
  };

  // ---- payments: scripted outcomes ----
  const intents = { get: (k: string) => state.intents.get(k), set: (k: string, v: PaymentOutcome) => state.intents.set(k, v) };
  const refunds: string[] = [];
  const payments = {
    /**
     * What the next charge should do. Set it, call complete, get that outcome.
     *
     * 'lost' is the interesting one, and it is not in `PaymentOutcome` because it is not an
     * answer — it is the absence of one. The charge succeeds at the provider and then the
     * connection dies before we hear about it, so the fan has been billed and we have no
     * idea. Scenario 7 in tests/scenarios.test.ts covers what happens next.
     */
    nextResult: "ok" as PaymentOutcome | "lost",
    /** Simulated provider latency; > 0 forces a real event-loop yield inside charge(). */
    delayMs: 0,
    async charge(intentId: string): Promise<PaymentOutcome> {
      if (payments.delayMs > 0) await new Promise((r) => setTimeout(r, payments.delayMs));
      else await Promise.resolve(); // still yield once, so interleaving is possible
      const r = payments.nextResult;
      payments.nextResult = "ok";
      if (r === "lost") {
        intents.set(intentId, "ok"); // the provider charged...
        throw new Error("network: response lost"); // ...but we never heard back
      }
      intents.set(intentId, r);
      return r;
    },
    async status(intentId: string): Promise<PaymentOutcome> {
      return intents.get(intentId) ?? "unknown";
    },
    /**
     * Return money for a charge we should not have kept.
     *
     * A real provider call; here it just records the reference, which is enough to prove the
     * reconciliation path actually issued the refund rather than only logging its intent to.
     * Called from the reconcile-conflict path in service.ts.
     */
    refund(intentId: string) { refunds.push(intentId); },
    /** Test/debug: which intents have been refunded. */
    refunded: () => [...refunds],
    // knob
    setStatus(intentId: string, o: PaymentOutcome) { intents.set(intentId, o); },
  };

  // ---- events: an in-memory log with a schema ----
  const log: Array<{ ts: number; name: string } & Record<string, unknown>> = [];
  const events = {
    emit(name: string, data: Record<string, unknown>) { log.push({ ts: clock.now(), name, ...data }); },
    all: () => log,
    clear: () => { log.length = 0; },
  };

  // ---- The way back ----
  //
  // Cross-surface checkout only pays off if something brings the fan back, so this stands in
  // for the push notification that would say "your seats are held for 3 more minutes". Here
  // it writes to the event log; the link it carries is the one served by
  // src/app/deeplink/[id]/route.ts. Called from `get` in service.ts.
  const notifier = {
    holdExpiringSoon(sessionId: string) {
      events.emit("hold_expiring_notified", { sessionId, deepLink: `/deeplink/${sessionId}` });
    },
  };

  // ---- Policy: the tunable business rules, gathered in one place ----
  const policy = {
    /**
     * How long a fan gets to finish checkout, given how much selling time is left.
     *
     * A fixed ten minutes is fine three days before an event and absurd eight minutes before
     * kickoff, where it would take seats off the market for most of the time anyone could
     * still buy them. So the window shrinks as the deadline approaches.
     *
     * The argument is time until *sales close*, not until the event starts — those differ by
     * a few minutes, and sales closing is the deadline that actually binds.
     *
     * The specific numbers are a product decision and probably wrong. What matters is that
     * they are one function in one place rather than a constant sprinkled through the code,
     * so changing the policy is a one-line change with a test on it.
     */
    holdWindowMs(msUntilCutoff: number) {
      if (msUntilCutoff <= 15 * MIN) return 2 * MIN;
      if (msUntilCutoff <= 60 * MIN) return 5 * MIN;
      return 10 * MIN;
    },

    // How long to wait for a payment provider to make up its mind before writing the session
    // off. Without this, a charge that never resolves would hold seats forever.
    pendingTimeoutMs: 2 * MIN,

    // How far ahead of the deadline the "your hold is running out" notice goes.
    //
    // Note what happens when the hold window itself is only two minutes, close to an event:
    // the notice fires immediately. That is not a bug, it is the policy showing its edges. A
    // reminder is only worth sending if there is still time to act on it, so a window that
    // short is really saying the reminder has stopped being useful.
    notifyLeadMs: 2 * MIN,
  };

  /** Rebuild all stub state in place. */
  function reset() {
    seed();
    payments.nextResult = "ok";
    payments.delayMs = 0;
    refunds.length = 0;
    events.clear();
  }

  const deps: Deps = { clock, ids, pricing, inventory, payments, events, notifier, policy };
  return { ...deps, clock, ids, pricing, inventory, payments, events, notifier, policy, reset };
}

export type Stubs = ReturnType<typeof makeStubs>;

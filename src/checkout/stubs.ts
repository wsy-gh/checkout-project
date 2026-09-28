import type { Alternative, Deps, PaymentOutcome } from "./types";
import { v7 as uuidv7 } from "uuid";

/**
 * STAND-INS FOR EVERYTHING OUTSIDE THIS APP
 *
 * Since the state machine in service.ts needs a clock, an inventory system, a pricing service and
 * a payment provider — and this is a prototype with none of those for real — this file provides
 * fake versions of all of them, each satisfying the `Deps` interface in types.ts.
 *
 * Two things make them worth reading rather than skipping:
 *
 * THE CLOCK IS A STUB TOO. Since nothing anywhere in this app calls `Date.now()` directly, a test
 * can say "eleven minutes pass" instantly and the demo can fast-forward to a hold running out
 * without anybody waiting. A real deployment passes in a clock that just reads the system time,
 * and nothing else changes.
 *
 * EACH ONE HAS KNOBS. Since the hard cases — a charge timing out, a price moving, a seller pulling
 * a listing — are exactly the ones you cannot wait around for, each stub exposes a way to trigger
 * them on demand (`payments.nextResult`, `pricing.setTotal`, `inventory.withdraw`,
 * `clock.advance`). The debug routes in src/app/api/debug/ expose those over HTTP so
 * scripts/demo.sh can drive the whole story with curl. Being able to say "the next charge times
 * out" in one line is the difference between testing the interesting paths and hoping they work.
 *
 * Nothing here is clever, on purpose: these exist only to make the real code testable.
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
  // Since these stub objects are held on globalThis (see src/lib/checkout.ts) and other modules
  // keep references to them, reset() must rebuild state without replacing the objects around it.
  // So every piece of changeable state lives inside this one `state` object, which reset() can
  // refill in place — swapping the stubs themselves would leave half the app talking to an
  // abandoned copy.
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

  // The clock is manual so that tests and the demo can jump it forward. When `opts.now` is given
  // it is frozen and only `advance` moves it; otherwise it tracks the system clock plus an offset.
  const clock = {
    now: () => (state.frozen ? state.t : Date.now() + state.offset),
    advance(ms: number) {
      if (state.frozen) state.t += ms;
      else state.offset += ms;
    },
    freeze(at: number) { state.frozen = true; state.t = at; },
  };

  // IDs are a readable prefix followed by a UUIDv7. They were once `cs_0001`, `cs_0002`, which read
  // beautifully in the demo but made the whole store walkable by counting — and since the link is
  // the only credential a session has (there is no auth), a guessable ID is the difference between
  // "you need the link" and "you need to be able to count". v7 rather than v4 because it begins
  // with a millisecond timestamp, so IDs sort by when they were minted (which keeps database index
  // inserts at one end rather than scattered, and here just means `_all()` comes back in a sensible
  // order); the remaining 74 random bits are what make it unguessable. The timestamp is taken from
  // the injected clock, not `Date.now()`, so a test that fast-forwards gets IDs consistent with its
  // own timeline.
  const ids = { next: (prefix: string) => `${prefix}_${uuidv7({ msecs: clock.now() })}` };

  seed();

  // Inventory and pricing share the one listing table.
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
     * Since picking genuinely comparable tickets is a real ranking problem in production and this
     * is a prototype, this returns simply "any other listing that still exists and has seats",
     * which is enough to make the point that a fan whose seats vanished should never be left
     * staring at a dead end.
     */
    alternatives: (id: string): Alternative[] =>
      [...listings.values()]
        .filter((l) => l.id !== id && !l.withdrawn && l.available > 0)
        .map((l) => ({ id: l.id, eventName: l.eventName, section: l.section, total: l.total })),
    // knobs the debug routes and tests use to force the hard cases
    withdraw(id: string) { need(id).withdrawn = true; },
    restore(id: string) { need(id).withdrawn = false; },
    all: () => [...listings.values()],
    get: need,
  };

  const pricing = {
    current: (id: string) => ({ total: need(id).total, version: need(id).priceVersion }),
    // knob: move a listing's price and bump its version so `priceChange` notices
    setTotal(id: string, total: number) {
      const l = need(id);
      l.total = total;
      l.priceVersion += 1;
    },
  };

  // The payment provider, with scripted outcomes.
  const intents = { get: (k: string) => state.intents.get(k), set: (k: string, v: PaymentOutcome) => state.intents.set(k, v) };
  const refunds: string[] = [];
  const payments = {
    /**
     * What the next charge should do: set it, call complete, and get that outcome back.
     *
     * `'lost'` is the interesting value, and it is not part of `PaymentOutcome` because it is not
     * an answer at all — it is the absence of one. It models the charge succeeding at the provider
     * and then the connection dying before we hear back, so the fan has been billed and we have no
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
     * In production this is a real provider call; here it just records the reference, which is
     * enough to prove the reconciliation path in service.ts actually issued the refund rather than
     * only intending to. Called from the reconcile-conflict path there.
     */
    refund(intentId: string) { refunds.push(intentId); },
    /** Test/debug: which intents have been refunded. */
    refunded: () => [...refunds],
    // knob: force the provider's answer for an intent, e.g. to make a late charge resolve
    setStatus(intentId: string, o: PaymentOutcome) { intents.set(intentId, o); },
  };

  // The event log: an in-memory list with a light schema, one record per emitted event.
  const log: Array<{ ts: number; name: string } & Record<string, unknown>> = [];
  const events = {
    emit(name: string, data: Record<string, unknown>) { log.push({ ts: clock.now(), name, ...data }); },
    all: () => log,
    clear: () => { log.length = 0; },
  };

  // The way back. Since cross-surface checkout only pays off if something brings the fan back,
  // this stands in for the push notification that would say "your seats are held for 3 more
  // minutes". Here it just writes to the event log; the deep link it carries is the one served by
  // src/app/deeplink/[id]/route.ts. Called from `get` in service.ts.
  const notifier = {
    holdExpiringSoon(sessionId: string) {
      events.emit("hold_expiring_notified", { sessionId, deepLink: `/deeplink/${sessionId}` });
    },
  };

  // The tunable business rules, gathered in one place.
  const policy = {
    /**
     * How long a fan gets to finish checkout, given how much selling time is left.
     *
     * Since a fixed ten minutes is fine three days before an event but absurd eight minutes before
     * kickoff — where it would take seats off the market for most of the time anyone could still
     * buy them — the window shrinks as the deadline approaches. The argument is time until *sales
     * close*, not until the event starts, because those differ by a few minutes and sales closing
     * is the deadline that actually binds. The specific numbers are a product decision and probably
     * wrong; what matters is that they live in one function rather than as a constant sprinkled
     * through the code, so changing the policy is a one-line change with a test on it.
     */
    holdWindowMs(msUntilCutoff: number) {
      if (msUntilCutoff <= 15 * MIN) return 2 * MIN;
      if (msUntilCutoff <= 60 * MIN) return 5 * MIN;
      return 10 * MIN;
    },

    // How long to wait for the provider to make up its mind before writing the session off.
    // Without this bound, a charge that never resolves would hold its seats forever.
    pendingTimeoutMs: 2 * MIN,

    // How far ahead of the deadline the "your hold is running out" notice goes out. Note that when
    // the hold window itself is only two minutes, close to an event, the notice fires immediately —
    // which is not a bug but the policy showing its edges: a reminder is only worth sending if
    // there is still time to act on it, so a window that short is really saying the reminder has
    // stopped being useful.
    notifyLeadMs: 2 * MIN,
  };

  /** Rebuild all stub state in place (see the note on `state` above for why in place). */
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

import type { Alternative, Deps, PaymentOutcome } from "./types";
import { v7 as uuidv7 } from "uuid";

/**
 * Stand-ins for everything outside the app, each satisfying the `Deps` interface.
 *
 * The clock is a stub too, and nothing anywhere calls `Date.now()` directly, so a test can say
 * "eleven minutes pass" instantly. Each stub also exposes a knob for the cases you cannot wait
 * around for — `payments.nextResult`, `pricing.setTotal`, `inventory.withdraw`, `clock.advance` —
 * which the debug routes expose over HTTP so scripts/demo.sh can drive the whole story with curl.
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
  // All changeable state lives in this one object so reset() can refill it in place: the stubs are
  // held on globalThis and other modules keep references, so replacing them would leave half the
  // app talking to an abandoned copy.
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

  // Manual so tests and the demo can jump it forward. With `opts.now` it is frozen and only
  // `advance` moves it; otherwise it tracks the system clock plus an offset.
  const clock = {
    now: () => (state.frozen ? state.t : Date.now() + state.offset),
    advance(ms: number) {
      if (state.frozen) state.t += ms;
      else state.offset += ms;
    },
    freeze(at: number) { state.frozen = true; state.t = at; },
  };

  // A readable prefix plus a UUIDv7. These were once `cs_0001`, `cs_0002`, which made the whole
  // store walkable by counting — and with no auth, the link is a session's only credential. v7
  // rather than v4 so ids sort by when they were minted (index inserts land at one end); the
  // remaining 74 random bits are what make them unguessable. The timestamp comes from the injected
  // clock, so a test that fast-forwards gets ids consistent with its own timeline.
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
    // Ranking genuinely comparable tickets is a real problem in production; this returns any other
    // listing that still has seats, which is enough to show that vanished seats need not be a dead end.
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
     * What the next charge should do. `'lost'` is the interesting value, and is not part of
     * `PaymentOutcome` because it is not an answer but the absence of one: the charge succeeds at
     * the provider and the connection dies before we hear back, so the fan has been billed and we
     * have no idea. Covered by scenario 7 in tests/scenarios.test.ts.
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
    // Records the reference rather than calling a provider, which is enough to prove the
    // reconciliation path actually issued the refund rather than only intending to.
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

  // Stands in for the push notification that would say "your seats are held for 3 more minutes" —
  // cross-surface checkout only pays off if something brings the fan back. Writes to the event log.
  const notifier = {
    holdExpiringSoon(sessionId: string) {
      events.emit("hold_expiring_notified", { sessionId, deepLink: `/deeplink/${sessionId}` });
    },
  };

  // The tunable business rules, gathered in one place.
  const policy = {
    /**
     * The window shrinks as the deadline approaches: a fixed ten minutes is fine three days out but
     * absurd eight minutes before kickoff, where it would take seats off the market for most of the
     * time anyone could still buy them. The argument is time until *sales close*, not until the
     * event starts, since sales closing is the deadline that binds. The numbers are a product
     * decision; what matters is that they live in one function rather than scattered as constants.
     */
    holdWindowMs(msUntilCutoff: number) {
      if (msUntilCutoff <= 15 * MIN) return 2 * MIN;
      if (msUntilCutoff <= 60 * MIN) return 5 * MIN;
      return 10 * MIN;
    },

    // How long to wait for the provider before writing the session off. Without this bound, a
    // charge that never resolves would hold its seats forever.
    pendingTimeoutMs: 2 * MIN,

    // How far ahead of the deadline the "hold running out" notice goes. When the window is itself
    // two minutes, close to an event, the notice fires immediately — the policy showing its edges
    // rather than a bug: a reminder with no time to act on it has stopped being useful.
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

import type { Deps, PaymentOutcome } from "./types";

/**
 * In-memory implementations of every external dependency, with knobs the tests and
 * the /api/debug route turn. Nothing here is clever on purpose.
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
  // ---- clock: manual, so tests and the demo can jump forward ----
  let t = opts.now ?? Date.now();
  let frozen = opts.now !== undefined;
  const clock = {
    now: () => (frozen ? t : Date.now() + offset),
    advance(ms: number) {
      if (frozen) t += ms;
      else offset += ms;
    },
    freeze(at: number) { frozen = true; t = at; },
  };
  let offset = 0;

  // ---- ids ----
  let n = 0;
  const ids = { next: (prefix: string) => `${prefix}_${(++n).toString(36).padStart(4, "0")}` };

  // ---- inventory + pricing share the listing table ----
  const base = clock.now();
  const listings = new Map<string, Listing>(
    [
      { id: "L1", eventName: "Warriors vs Lakers", section: "Sec 118, Row 12", available: 4, total: 8900, eventStartsAt: base + 90 * MIN },
      { id: "L2", eventName: "Giants vs Dodgers", section: "Club Level 214", available: 2, total: 6400, eventStartsAt: base + 25 * MIN },
      { id: "L3", eventName: "Sharks vs Kings", section: "Sec 209", available: 1, total: 4200, eventStartsAt: base + 6 * 60 * MIN },
    ].map((l) => [l.id, { ...l, priceVersion: 1, withdrawn: false, cutoffLeadMs: 5 * MIN }]),
  );
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
  const intents = new Map<string, PaymentOutcome>();
  const payments = {
    /** Outcome of the next charge(). 'lost' = charge succeeds provider-side but the response never arrives. */
    nextResult: "ok" as PaymentOutcome | "lost",
    /** Simulated provider latency; > 0 forces a real event-loop yield inside charge(). */
    delayMs: 0,
    async charge(intentId: string, _token: string): Promise<PaymentOutcome> {
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

  // ---- notifier: the return path. In the prototype it only logs. ----
  const notifier = {
    holdExpiringSoon(sessionId: string, deepLink: string) {
      events.emit("hold_expiring_notified", { sessionId, deepLink });
    },
  };

  // ---- policy ----
  const policy = {
    holdWindowMs(msUntilEvent: number) {
      // Shorter holds as the event approaches: 10 min normally, 5 min inside the last hour,
      // 2 min inside the last 15. The point is that it's a function, in one place.
      if (msUntilEvent <= 15 * MIN) return 2 * MIN;
      if (msUntilEvent <= 60 * MIN) return 5 * MIN;
      return 10 * MIN;
    },
    pendingTimeoutMs: 2 * MIN,
  };

  const deps: Deps = { clock, ids, pricing, inventory, payments, events, policy };
  return { ...deps, clock, ids, pricing, inventory, payments, events, notifier, policy };
}

export type Stubs = ReturnType<typeof makeStubs>;

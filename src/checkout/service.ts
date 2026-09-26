import {
  CheckoutError,
  TERMINAL,
  type AcceptPriceInput,
  type CompleteInput,
  type CreateInput,
  type Deps,
  type FailReason,
  type PaymentOutcome,
  type Session,
  type SessionOf,
} from "./types";
import { assertInvariants } from "./invariants";

/**
 * The checkout session state machine.
 *
 * One process, one Map, no locks: every write below is synchronous, so the only way to
 * introduce a race is to `await` between reading a session and writing it. The single
 * place we do that on purpose — the payment call in `complete` — is fenced off by the
 * status flip to PAYMENT_PENDING that happens *before* the await. That flip is the
 * compare-and-set that keeps two devices from both charging.
 */
export function createCheckout(deps: Deps) {
  const db = new Map<string, Session>();

  // ---------- helpers ----------

  const fail = (code: CheckoutError["code"], s?: Session, extra?: Record<string, unknown>): never => {
    throw new CheckoutError(code, s, extra);
  };

  /** The only writer. Bumps version and checks invariants on every mutation. */
  function put(next: Session): Session {
    const s = { ...next, version: next.version + 1 };
    assertInvariants(s, deps.clock.now(), deps.inventory.salesCutoff(s.listingId));
    db.set(s.id, s);
    return s;
  }

  function release(s: Session, to: { status: "EXPIRED" } | { status: "FAILED"; failReason: FailReason }): Session {
    deps.inventory.release(s.listingId, s.quantity);
    const next = put({ ...strip(s), ...to });
    deps.events.emit(to.status === "EXPIRED" ? "hold_expired" : "session_failed", {
      sessionId: s.id,
      reason: to.status === "FAILED" ? to.failReason : undefined,
    });
    return next;
  }

  /** Drop variant-specific fields so a spread cannot smuggle e.g. orderId into FAILED. */
  function strip(s: Session) {
    const rest = { ...s } as Partial<Session> &
      Partial<Record<"paymentIntentId" | "pendingSince" | "orderId" | "failReason" | "successorSessionId", unknown>>;
    delete rest.status;
    delete rest.paymentIntentId;
    delete rest.pendingSince;
    delete rest.orderId;
    delete rest.failReason;
    delete rest.successorSessionId;
    return rest as Omit<Session, "status">;
  }

  /** Resolve a PENDING session from the provider's answer. Stays PENDING while unknown. */
  function settle(s: SessionOf<"PAYMENT_PENDING">, outcome: PaymentOutcome, now: number): Session {
    if (outcome === "ok") {
      const done = put({ ...strip(s), status: "COMPLETED", paymentIntentId: s.paymentIntentId, orderId: deps.ids.next("ord") });
      deps.events.emit("completed", { sessionId: s.id, orderId: (done as SessionOf<"COMPLETED">).orderId });
      return done;
    }
    if (outcome === "declined") return release(s, { status: "FAILED", failReason: "DECLINED" });
    if (now - s.pendingSince > deps.policy.pendingTimeoutMs) return release(s, { status: "FAILED", failReason: "PENDING_TIMEOUT" });
    return s;
  }

  // ---------- operations ----------

  function create(input: CreateInput): Session {
    const now = deps.clock.now();
    if (!deps.inventory.backs(input.listingId)) fail("INVENTORY_WITHDRAWN");
    if (!deps.inventory.hold(input.listingId, input.quantity)) fail("SOLD_OUT");

    const cutoff = deps.inventory.salesCutoff(input.listingId);
    const price = deps.pricing.current(input.listingId);
    const s = put({
      id: deps.ids.next("cs"),
      listingId: input.listingId,
      quantity: input.quantity,
      quotedTotal: price.total * input.quantity,
      priceVersion: price.version,
      // The one last-minute-specific rule: a hold never outlives the sales cutoff.
      holdExpiresAt: Math.min(now + deps.policy.holdWindowMs(cutoff - now), cutoff),
      version: 0,
      status: "ACTIVE",
      createdOn: input.surface,
      lastSeenOn: input.surface,
      idempotency: {},
      createdAt: now,
    });
    deps.events.emit("session_created", { sessionId: s.id, surface: input.surface });
    return s;
  }

  /**
   * Reconcile-on-read. Expiry and withdrawal are predicates on ACTIVE, evaluated here;
   * nothing has to fire when a deadline passes. PENDING is the one status that needs the
   * provider, so `get` is async, but the ACTIVE branches write synchronously.
   */
  async function get(id: string, seenOn?: CreateInput["surface"]): Promise<Session> {
    let s = db.get(id) ?? fail("NOT_FOUND");
    const now = deps.clock.now();

    if (s.status === "ACTIVE" && now >= s.holdExpiresAt) s = release(s, { status: "EXPIRED" });
    else if (s.status === "ACTIVE" && !deps.inventory.backs(s.listingId))
      s = release(s, { status: "FAILED", failReason: "INVENTORY_WITHDRAWN" });
    else if (s.status === "PAYMENT_PENDING") s = settle(s, await deps.payments.status(s.paymentIntentId), now);

    if (seenOn && seenOn !== s.lastSeenOn) {
      deps.events.emit("session_resumed", { sessionId: s.id, surface: seenOn, fromSurface: s.lastSeenOn, ageMs: now - s.createdAt });
      // Telemetry, not state: a read from another surface must not invalidate a device's version.
      s = { ...s, lastSeenOn: seenOn };
      db.set(s.id, s);
    }
    return s;
  }

  /**
   * `get` is async (PENDING may consult the provider), so anything that ran `await get()`
   * holds a snapshot. Mutations must re-read the row synchronously and keep no await
   * between that read and their write. This is the whole concurrency story.
   */
  function current(id: string): Session {
    return db.get(id) ?? fail("NOT_FOUND");
  }

  /** What a client needs to know alongside the session. */
  function priceChange(s: Session) {
    if (s.status !== "ACTIVE") return undefined;
    const live = deps.pricing.current(s.listingId);
    if (live.version === s.priceVersion) return undefined;
    return { from: s.quotedTotal, to: live.total * s.quantity, newPriceVersion: live.version };
  }

  async function acceptPrice(id: string, input: AcceptPriceInput): Promise<Session> {
    await get(id, input.surface); // reconcile first
    const s = current(id); // then read the live row, synchronously
    if (s.status !== "ACTIVE") fail(statusError(s), s);
    if (input.version !== s.version) fail("STALE_VERSION", s);
    const live = deps.pricing.current(s.listingId);
    if (input.priceVersion !== live.version) fail("PRICE_CHANGED", s, { priceChange: priceChange(s) });
    const next = put({ ...s, quotedTotal: live.total * s.quantity, priceVersion: live.version });
    deps.events.emit("price_change_accepted", { sessionId: s.id, from: s.quotedTotal, to: next.quotedTotal });
    return next;
  }

  async function complete(id: string, input: CompleteInput): Promise<Session> {
    await get(id, input.surface); // reconcile expiry / withdrawal / pending first
    const s = current(id); // ---- from here to `put` below: synchronous, no await ----

    // Same device retrying: replay, never re-charge.
    if (input.idempotencyKey in s.idempotency) return s;

    // Different device, or a stale tab: reject with the truth.
    if (s.status === "PAYMENT_PENDING") fail("IN_PROGRESS_ELSEWHERE", s);
    if (s.status !== "ACTIVE") fail(statusError(s), s);
    if (input.version !== s.version) fail("STALE_VERSION", s);

    // Two comparisons: did this device see the session's price, and is that price still live?
    const live = deps.pricing.current(s.listingId);
    if (input.priceVersion !== s.priceVersion || s.priceVersion !== live.version)
      fail("PRICE_CHANGED", s, { priceChange: priceChange(s) ?? { from: s.quotedTotal, to: s.quotedTotal, newPriceVersion: s.priceVersion } });

    // ---- end of critical section: this write is the compare-and-set ----
    const pending = put({
      ...strip(s),
      status: "PAYMENT_PENDING",
      paymentIntentId: s.id, // session id doubles as the provider idempotency key
      pendingSince: deps.clock.now(),
    }) as SessionOf<"PAYMENT_PENDING">;
    deps.events.emit("payment_started", { sessionId: s.id, surface: input.surface });

    // Outside the critical section. The hold is frozen; expiry no longer applies.
    const outcome = await deps.payments.charge(pending.paymentIntentId, input.paymentToken);

    const settled = settle(pending, outcome, deps.clock.now());
    const withReplay = put({ ...settled, idempotency: { ...settled.idempotency, [input.idempotencyKey]: outcome } });
    if (outcome === "declined") fail("PAYMENT_DECLINED", withReplay);
    return withReplay;
  }

  /** Re-hold after expiry: a fresh session that the old deep link can forward to. */
  function rehold(id: string): Session {
    const old = db.get(id) ?? fail("NOT_FOUND");
    if (old.status !== "EXPIRED") return fail(statusError(old), old);
    if (old.successorSessionId) return db.get(old.successorSessionId)!;
    const next = create({ listingId: old.listingId, quantity: old.quantity, surface: old.lastSeenOn });
    put({ ...old, successorSessionId: next.id });
    return next;
  }

  function statusError(s: Session) {
    if (s.status === "COMPLETED") return "ALREADY_COMPLETED" as const;
    if (s.status === "EXPIRED") return "EXPIRED" as const;
    if (s.status === "FAILED") return s.failReason === "INVENTORY_WITHDRAWN" ? ("INVENTORY_WITHDRAWN" as const) : ("ALREADY_FAILED" as const);
    return "IN_PROGRESS_ELSEWHERE" as const;
  }

  return {
    create,
    get,
    acceptPrice,
    complete,
    rehold,
    priceChange,
    /** Test/debug only. */
    _all: () => [...db.values()],
    _reset: () => db.clear(),
    _isTerminal: (s: Session) => TERMINAL.has(s.status),
  };
}

export type Checkout = ReturnType<typeof createCheckout>;

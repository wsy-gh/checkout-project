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
import { assertInvariants, assertTransition } from "./invariants";

/**
 * The checkout state machine: the only place that decides what may happen to a session. Routes,
 * Server Actions and pages are thin wrappers over these functions.
 *
 * The rule this file is built around:
 *
 *     Never `await` between reading a session and writing it back.
 *
 * Node only yields at an `await`, so an un-awaited read-then-write is effectively atomic and needs no
 * locks. `complete` and `get` must await the payment provider, so both discard the session they held,
 * re-read it by id, and check it is still in the status their write assumes.
 *
 * Re-checking the status is sufficient because status only moves forward:
 *
 *     ACTIVE ──> PAYMENT_PENDING ──> COMPLETED
 *        │              └──────────> FAILED
 *        ├──> EXPIRED
 *        └──> FAILED
 *
 * So "still PAYMENT_PENDING?" also proves nothing happened while we waited. invariants.ts enforces
 * that shape on every write, so a future transition that breaks this reasoning fails the tests.
 */
export function createCheckout(deps: Deps) {
  const db = new Map<string, Session>();

  // Sessions already sent a "hold expiring" notice — notifier bookkeeping, not session state, and it
  // keeps the notice to one per session across refreshes.
  const notified = new Set<string>();

  // ---------- helpers ----------

  // Every rejection carries the session as it currently is, so the client can redraw from the
  // error without a second request. src/lib/respond.ts turns this into an HTTP response.
  const fail = (code: CheckoutError["code"], s?: Session, extra?: Record<string, unknown>): never => {
    throw new CheckoutError(code, s, extra);
  };

  // The only place a session is written: centralised so `version` cannot be forgotten (the staleness
  // checks depend on it) and every write is validated before being stored.
  function put(next: Session): Session {
    const s = { ...next, version: next.version + 1 };
    assertTransition(db.get(s.id), s);
    assertInvariants(s, deps.clock.now(), deps.inventory.salesCutoff(s.listingId));
    db.set(s.id, s);
    return s;
  }

  /**
   * End a session and return its seats. Releasing inventory and recording why are one event: split
   * across an `await`, a crash between them leaves seats no session holds and nobody can buy.
   *
   * `event` overrides the name logged, which `cancel` uses: a fan who deliberately gives up a hold
   * reaches the same EXPIRED state as one whose timer ran out, and counting the two together would
   * make the share of holds that lapse — a hold-window tuning signal — read higher than it is.
   */
  function release(
    s: Session,
    to: { status: "EXPIRED" } | { status: "FAILED"; failReason: FailReason; unresolvedIntentId?: string },
    event?: string,
  ): Session {
    deps.inventory.release(s.listingId, s.quantity);
    const next = put({ ...strip(s), ...to });
    deps.events.emit(event ?? (to.status === "EXPIRED" ? "hold_expired" : "session_failed"), {
      sessionId: s.id,
      reason: to.status === "FAILED" ? to.failReason : undefined,
    });
    return next;
  }

  /**
   * Drop every status-specific field. Each status owns extras (COMPLETED an `orderId`, FAILED a
   * `failReason`), so spreading a session into a new status would carry the old one's fields along —
   * a FAILED session still holding an order id — and a runtime spread is invisible to the types.
   */
  function strip(s: Session) {
    const rest = { ...s } as Partial<Session> &
      Partial<
        Record<"paymentIntentId" | "pendingSince" | "orderId" | "failReason" | "successorSessionId" | "unresolvedIntentId", unknown>
      >;
    delete rest.status;
    delete rest.paymentIntentId;
    delete rest.pendingSince;
    delete rest.orderId;
    delete rest.failReason;
    delete rest.successorSessionId;
    delete rest.unresolvedIntentId;
    return rest as Omit<Session, "status">;
  }

  /**
   * Record the provider's answer for a session awaiting a charge. Takes an id, not a session: every
   * caller arrives after awaiting the provider, so any session they hold predates the wait.
   * Re-reading and re-checking the status is what stops two concurrent settles from releasing the
   * same seats twice (four seats becoming six) or minting two order ids for one payment.
   */
  function settle(id: string, outcome: PaymentOutcome): Session {
    const s = db.get(id) ?? fail("NOT_FOUND");
    if (s.status !== "PAYMENT_PENDING") {
      // Someone settled first, so their answer stands. Harmless except in one case: a charge that
      // succeeded after the pending timeout already wrote the session off means the card was
      // charged for seats now back on sale, so a refund is owed. Guarded by the unresolved intent,
      // so it cannot refund twice.
      if (outcome === "ok" && s.status === "FAILED" && s.unresolvedIntentId) return reconcileChargedButFailed(s);
      return s;
    }
    if (outcome === "ok") {
      const done = put({ ...strip(s), status: "COMPLETED", paymentIntentId: s.paymentIntentId, orderId: deps.ids.next("ord") });
      deps.events.emit("completed", { sessionId: s.id, orderId: (done as SessionOf<"COMPLETED">).orderId });
      return done;
    }
    if (outcome === "declined") return release(s, { status: "FAILED", failReason: "DECLINED" });
    if (deps.clock.now() - s.pendingSince > deps.policy.pendingTimeoutMs)
      // Out of time but still "unknown", so the charge may yet land: keep the intent reference on
      // the failed session for a later read to ask about again (see settleFailed).
      return release(s, { status: "FAILED", failReason: "PENDING_TIMEOUT", unresolvedIntentId: s.paymentIntentId });
    return s;
  }

  /**
   * A charge we had written off actually succeeded, so refund it — the fan paid for seats that
   * went back on sale. Clearing `unresolvedIntentId` is what stops a later read refunding again.
   */
  function reconcileChargedButFailed(s: SessionOf<"FAILED">): Session {
    deps.payments.refund(s.unresolvedIntentId!);
    deps.events.emit("reconcile_conflict", { sessionId: s.id, intentId: s.unresolvedIntentId, status: s.status });
    deps.events.emit("refund_issued", { sessionId: s.id, intentId: s.unresolvedIntentId });
    return put({ ...s, unresolvedIntentId: undefined });
  }

  // Resolve a FAILED session still carrying an uncertain payment reference. Mirrors `settle`: its
  // callers also arrive after an await, so it re-reads by id. Still "unknown" keeps the reference.
  function settleFailed(id: string, outcome: PaymentOutcome): Session {
    const s = db.get(id) ?? fail("NOT_FOUND");
    if (s.status !== "FAILED" || !s.unresolvedIntentId) return s;
    if (outcome === "ok") return reconcileChargedButFailed(s);
    if (outcome === "declined") return put({ ...s, unresolvedIntentId: undefined });
    return s;
  }

  // Alternatives to offer a fan whose listing was withdrawn — the one failure where they lost
  // their seats through no action of their own, so "gone" would otherwise be a dead end.
  const alternativesFor = (s: Session) =>
    s.status === "FAILED" && s.failReason === "INVENTORY_WITHDRAWN"
      ? { alternatives: deps.inventory.alternatives(s.listingId) }
      : undefined;

  /**
   * Release lapsed holds and reconcile abandoned payments.
   *
   * Expiry is normally noticed on read, which leaves no window where the clock has passed but a
   * cleanup job has not run. The gap is the session nobody will ever read again — the fan who closed
   * the tab — whose seats would stay unsellable, so deadlines are checked on behalf of whoever
   * actually cares: the next fan buying. Called from `create` and the pages showing seat counts.
   */
  async function sweepExpired(listingId?: string): Promise<void> {
    const now = deps.clock.now();
    for (const s of [...db.values()]) {
      if (listingId !== undefined && s.listingId !== listingId) continue;
      if (s.status === "ACTIVE" && now >= s.holdExpiresAt) {
        release(s, { status: "EXPIRED" });
      } else if (s.status === "PAYMENT_PENDING" && now - s.pendingSince > deps.policy.pendingTimeoutMs) {
        // Nobody is waiting on this payment any more, so its seats must not stay held on a charge
        // the buyer walked away from.
        settle(s.id, await deps.payments.status(s.paymentIntentId));
      } else if (s.status === "FAILED" && s.unresolvedIntentId) {
        // Check a written-off payment once more, so a late success is refunded even if the buyer
        // never comes back.
        settleFailed(s.id, await deps.payments.status(s.unresolvedIntentId));
      }
    }
  }

  // ---------- operations ----------

  /** Start a checkout: take the seats, quote a price, set the deadline. */
  async function create(input: CreateInput): Promise<Session> {
    // Validated here rather than in the routes because there are two front doors (HTTP and the
    // Server Action). The integer check matters: `Number("abc")` is NaN and every NaN comparison
    // is false, so a NaN quantity would pass `available < quantity` and corrupt the seat count.
    if (typeof input.listingId !== "string" || input.listingId === "") fail("INVALID_REQUEST");
    if (!Number.isInteger(input.quantity) || input.quantity < 1) fail("INVALID_REQUEST");
    const now = deps.clock.now();
    // Count what is really available, and ensure the dedup check below sees only live holds.
    await sweepExpired(input.listingId);

    // Without this, one browser repeating Buy → Start → Back drains a listing through separate
    // sessions — the idempotency key cannot stop it, since each attempt is a different session.
    // A browser already holding a live session for this listing gets that session back, which
    // makes repeating the flow resume rather than hold again. PENDING counts as live, so someone
    // mid-payment is returned to it. Callers without the cookie (raw API, tests) skip this.
    if (input.clientId) {
      const existing = [...db.values()].find(
        (x) => x.clientId === input.clientId && x.listingId === input.listingId && (x.status === "ACTIVE" || x.status === "PAYMENT_PENDING"),
      );
      if (existing) {
        deps.events.emit("hold_resumed_same_client", { sessionId: existing.id, clientId: input.clientId });
        return existing;
      }
    }

    if (!deps.inventory.backs(input.listingId)) fail("INVENTORY_WITHDRAWN");

    // Past the sales cutoff, `min(now + window, cutoff)` is a deadline in the past, so the fan
    // would get a live-looking page whose first refresh says the hold ended. Checked before any
    // seats are taken, so a refused checkout has nothing to give back.
    const cutoff = deps.inventory.salesCutoff(input.listingId);
    if (now >= cutoff) fail("SALES_CLOSED");

    if (!deps.inventory.hold(input.listingId, input.quantity)) fail("SOLD_OUT");

    const price = deps.pricing.current(input.listingId);
    const s = put({
      id: deps.ids.next("cs"),
      listingId: input.listingId,
      quantity: input.quantity,
      quotedTotal: price.total * input.quantity,
      priceVersion: price.version,
      // The hold window shrinks as the event approaches (see `policy.holdWindowMs`), and a hold
      // can never outlive the sales cutoff, so take whichever comes first.
      holdExpiresAt: Math.min(now + deps.policy.holdWindowMs(cutoff - now), cutoff),
      version: 0,
      status: "ACTIVE",
      createdOn: input.surface,
      lastSeenOn: input.surface,
      clientId: input.clientId,
      idempotency: {},
      createdAt: now,
    });
    deps.events.emit("session_created", { sessionId: s.id, surface: input.surface });
    return s;
  }

  /**
   * Read a session, bringing it up to date first. There is no separate "resume" concept: resuming is
   * reading. Three things go stale while nobody looks — the deadline passed, the listing was
   * withdrawn, a payment was in flight — and only the last needs the network.
   */
  async function get(id: string, seenOn?: CreateInput["surface"]): Promise<Session> {
    let s = db.get(id) ?? fail("NOT_FOUND");
    const now = deps.clock.now();

    // Only ACTIVE sessions expire. A session awaiting a charge must be immune to the clock: if the
    // deadline fired mid-charge we would resell seats while the first fan's card was being charged.
    if (s.status === "ACTIVE" && now >= s.holdExpiresAt) s = release(s, { status: "EXPIRED" });
    else if (s.status === "ACTIVE" && !deps.inventory.backs(s.listingId))
      s = release(s, { status: "FAILED", failReason: "INVENTORY_WITHDRAWN" });
    // `s` is stale from this await onwards, which is why `settle` re-reads rather than trusting it.
    else if (s.status === "PAYMENT_PENDING") s = settle(s.id, await deps.payments.status(s.paymentIntentId));
    // Read-path half of the same reconciliation the sweep does; a no-op once resolved.
    else if (s.status === "FAILED" && s.unresolvedIntentId) s = settleFailed(s.id, await deps.payments.status(s.unresolvedIntentId));

    if (seenOn && seenOn !== s.lastSeenOn) {
      deps.events.emit("session_resumed", { sessionId: s.id, surface: seenOn, fromSurface: s.lastSeenOn, ageMs: now - s.createdAt });
      // Written straight to the map rather than through `put` — the one deliberate exception —
      // because `put` bumps `version`, and `version` tells a device its copy is stale. Glancing at
      // the checkout on a phone would otherwise start failing the laptop's Pay button.
      s = { ...s, lastSeenOn: seenOn };
      db.set(s.id, s);
    }

    // Nudge the fan before the hold runs out. A real system would schedule this; the clock here is
    // a stub tests fast-forward, so the next read is the honest substitute.
    if (s.status === "ACTIVE" && now >= s.holdExpiresAt - deps.policy.notifyLeadMs && !notified.has(s.id)) {
      notified.add(s.id);
      deps.notifier.holdExpiringSoon(s.id);
    }
    return s;
  }

  // The session as it is now, without updating or awaiting. Callers that intend to *change* a session
  // call this immediately before doing so, then check and write with no `await` between.
  function current(id: string): Session {
    return db.get(id) ?? fail("NOT_FOUND");
  }

  // Reports only: the session is never re-quoted behind the fan's back, and `acceptPrice` is the only
  // thing that records agreement to a new price.
  function priceChange(s: Session) {
    if (s.status !== "ACTIVE") return undefined;
    const live = deps.pricing.current(s.listingId);
    if (live.version === s.priceVersion) return undefined;
    return { from: s.quotedTotal, to: live.total * s.quantity, newPriceVersion: live.version };
  }

  /** Record that the fan has seen the new price and agreed to it. */
  async function acceptPrice(id: string, input: AcceptPriceInput): Promise<Session> {
    await get(id, input.surface); // may pause
    const s = current(id); // from here down: no pausing
    if (s.status !== "ACTIVE") fail(statusError(s), s, alternativesFor(s));
    if (input.version !== s.version) fail("STALE_VERSION", s);
    const live = deps.pricing.current(s.listingId);
    if (input.priceVersion !== live.version) fail("PRICE_CHANGED", s, { priceChange: priceChange(s) });
    const next = put({ ...s, quotedTotal: live.total * s.quantity, priceVersion: live.version });
    deps.events.emit("price_change_accepted", { sessionId: s.id, from: s.quotedTotal, to: next.quotedTotal });
    return next;
  }

  /**
   * A client checking the status code before the body would read any 200 as a completed purchase, so
   * only COMPLETED (money moved) and PAYMENT_PENDING (still finding out) return normally. Anything
   * else ended for a reason unrelated to this press — usually the pending timeout — and is rejected.
   */
  function answer(s: Session): Session {
    if (s.status === "COMPLETED" || s.status === "PAYMENT_PENDING") return s;
    return fail(statusError(s), s, alternativesFor(s));
  }

  /**
   * Charge the card and turn the hold into an order.
   *
   * Two different ways a fan ends up asking to pay twice, each needing its own mechanism:
   *
   *   Two devices, two attempts. Laptop and phone both press Pay. One should win and the other be
   *   told it is already paying elsewhere — done by the status check: whoever gets there first
   *   flips the session to PAYMENT_PENDING and the second finds it no longer ACTIVE.
   *
   *   One attempt, sent twice. A double-click, or a retry after a dropped reply. The second should
   *   return the first's result — done by the idempotency key, one per rendered form, so both
   *   copies of one attempt share it.
   *
   * Neither can do the other's job: the status check would tell a retry it is competing with
   * itself, and two devices hold different keys.
   */
  async function complete(id: string, input: CompleteInput): Promise<Session> {
    // The key must be a real non-empty string: callers used to reach this through `String(...)`,
    // where `String({})` is "[object Object]", so every non-string key collided on one value and
    // unrelated attempts were handed each other's orders. Length-capped because it is stored for
    // the session's lifetime.
    if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey || input.idempotencyKey.length > 200)
      fail("INVALID_REQUEST");

    // Required with no default: the stub ignores the token, so a missing one would silently "work"
    // here and attempt a charge against a placeholder once wired to a real provider.
    if (typeof input.paymentToken !== "string" || !input.paymentToken) fail("INVALID_REQUEST");
    await get(id, input.surface); // may pause
    const s = current(id); // ---- from here to the `put` below: no pausing ----

    // `Object.hasOwn` rather than a bare lookup: `idempotency` is a plain object, so keys like
    // "constructor" match an inherited property and a first-ever attempt would be rejected as a
    // replay. Since the key is claimed in the same write that flips to PAYMENT_PENDING, this also
    // catches a second copy arriving while the first is in flight.
    const replayed = Object.hasOwn(s.idempotency, input.idempotencyKey) ? s.idempotency[input.idempotencyKey] : undefined;
    if (replayed !== undefined) {
      // Replay the original answer, failure included — a cheerful 200 for a retry of a decline
      // would read as success.
      if (replayed === "declined") fail("PAYMENT_DECLINED", s);
      return answer(s);
    }

    if (s.status === "PAYMENT_PENDING") fail("IN_PROGRESS_ELSEWHERE", s);
    if (s.status !== "ACTIVE") fail(statusError(s), s, alternativesFor(s));
    // A version mismatch means this press was made against information the fan can no longer see
    // (perhaps the other device accepted a price change), so refuse and let their screen catch up.
    if (input.version !== s.version) fail("STALE_VERSION", s);

    // Two independent price checks, both needed: did this device see the price the session holds,
    // and does the session's price still match the listing? The first alone misses a price change
    // between page load and Pay, where the versions still agree because the session never changed.
    const live = deps.pricing.current(s.listingId);
    if (input.priceVersion !== s.priceVersion || s.priceVersion !== live.version)
      fail("PRICE_CHANGED", s, { priceChange: priceChange(s) ?? { from: s.quotedTotal, to: s.quotedTotal, newPriceVersion: s.priceVersion } });

    // The write that decides who gets to pay. Nothing above paused, so the checks were still true
    // when this landed, and flipping to PAYMENT_PENDING closes the door on later attempts.
    const pending = put({
      ...strip(s),
      status: "PAYMENT_PENDING",

      // The intent is recorded before the charge is attempted, so if this process dies one line
      // from now the next read can still ask the provider what happened to it. Deriving it from
      // the session id also means asking the provider to charge it twice cannot produce two
      // charges, since providers treat a repeated id as the same request.
      paymentIntentId: s.id,
      pendingSince: deps.clock.now(),

      // The key is claimed in this write rather than after the charge returns: waiting would let a
      // double-click find no key recorded and be told it was competing with another device about
      // itself. "unknown" means "underway, outcome not yet known", which is what a second copy
      // should be told; the real outcome overwrites it below.
      idempotency: { ...s.idempotency, [input.idempotencyKey]: "unknown" },
    }) as SessionOf<"PAYMENT_PENDING">;
    deps.events.emit("payment_started", { sessionId: s.id, surface: input.surface });

    // The pause. Other requests run during it; the seats are safe because the session is no longer
    // ACTIVE, so the clock cannot expire it out from under the charge.
    const outcome = await deps.payments
      .charge(pending.paymentIntentId, input.paymentToken)
      // A thrown call says nothing about whether the card was charged, and treating that as failure
      // is the most expensive mistake available here: the fan retries and is billed twice. So it
      // becomes "unknown", the seats stay held, and the next read asks the provider what happened.
      .catch((): PaymentOutcome => "unknown");

    const settled = settle(id, outcome);

    // Record the outcome against this attempt's key, so a retry replays it instead of charging again.
    const withReplay = put({ ...settled, idempotency: { ...settled.idempotency, [input.idempotencyKey]: outcome } });

    // A decline is safe to act on — we know no money moved, unlike "unknown", which `answer` lets
    // through with the session still pending.
    if (outcome === "declined") fail("PAYMENT_DECLINED", withReplay);
    return answer(withReplay);
  }

  /**
   * An expired session is final, so this creates a new one for the same seats and points the old at
   * it, which keeps stale links and notifications useful. Calling it twice returns the same successor
   * rather than holding a second set of seats — "Try again" is pressed repeatedly by frustrated people.
   */
  async function rehold(id: string): Promise<Session> {
    const old = db.get(id) ?? fail("NOT_FOUND");
    if (old.status !== "EXPIRED") return fail(statusError(old), old, alternativesFor(old));
    if (old.successorSessionId) return db.get(old.successorSessionId)!;
    // Carry the browser identity onto the successor, so the new hold is still owned by the same
    // client for dedup and for the home-page resume banner.
    const next = await create({ listingId: old.listingId, quantity: old.quantity, surface: old.lastSeenOn, clientId: old.clientId });
    put({ ...old, successorSessionId: next.id });
    return next;
  }

  /**
   * Give up a hold on purpose, freeing the seats now instead of when the timer runs out.
   *
   * It ends at EXPIRED rather than getting a status of its own, because the outcome is identical —
   * the hold is over and the seats are back on sale — so reusing it means no new state, no new
   * screen, and the existing "try again" path keeps working on the abandoned session. Only the
   * logged event differs.
   *
   * Reading first, through `get`, matters for more than tidiness: it settles a charge that resolved
   * while nobody was looking, so a session that has actually completed is refused as
   * ALREADY_COMPLETED rather than as a payment in progress.
   */
  async function cancel(id: string): Promise<Session> {
    await get(id); // may pause
    const s = current(id); // from here down: no pausing
    // Only a live hold can be given up. A charge in flight must never have its seats pulled from
    // under it, and a paid order must never be un-sold, so every other status is refused with the
    // code that already describes it — including a hold that lapsed a moment ago, whose seats the
    // read above has already returned.
    if (s.status !== "ACTIVE") fail(statusError(s), s, alternativesFor(s));
    return release(s, { status: "EXPIRED" }, "hold_released_by_fan");
  }

  // Picks the code that best explains why a session cannot be acted on. Not shown to the fan: it
  // selects which wording and button RecoveryState.tsx renders.
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
    cancel,
    priceChange,
    alternativesFor,
    /** Call before showing how many seats are left, so lapsed holds are already back. */
    sweepExpired,
    /**
     * Live holds, newest first. Read-only. Backs the home page's resume banner — a way back into an
     * abandoned checkout needing no notification infrastructure. A `clientId` scopes the list to one
     * browser's own holds; without one it returns every live hold, which the tests and demo rely on.
     */
    resumable: (clientId?: string) => {
      const now = deps.clock.now();
      return [...db.values()]
        .filter((s) => s.status === "ACTIVE" && now < s.holdExpiresAt && (clientId === undefined || s.clientId === clientId))
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    // Underscored: used by the tests and GET /api/debug/state, never by the application.
    _all: () => [...db.values()],
    _reset: () => { db.clear(); notified.clear(); },
    _isTerminal: (s: Session) => TERMINAL.has(s.status),
  };
}

export type Checkout = ReturnType<typeof createCheckout>;

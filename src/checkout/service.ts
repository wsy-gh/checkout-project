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
 * THE CHECKOUT STATE MACHINE
 *
 * Since every rule in the app has to live in exactly one place to be trustworthy, this is that
 * place — the only file that decides what may happen to a checkout session. Everything else is a
 * thin wrapper: the HTTP routes in src/app/api/sessions/ call these functions and turn the result
 * into JSON, the Server Actions in src/app/actions.ts call the same functions for the web forms,
 * and the pages just draw whatever session comes back.
 *
 *
 * WHAT A SESSION IS
 *
 * When a fan starts checkout we take seats out of the available pool and write down a record: which
 * listing, how many seats, the price we quoted, and the moment those seats go back if nobody pays.
 * That record is the session, and the fan's browser is handed its ID and nothing else. Since the
 * server is then the only thing that ever knew anything about the checkout, "start on web, finish
 * on your phone" needs nothing copied to the phone and no communication between the two devices:
 * the phone asks the server about the same ID and gets the same answer.
 *
 *
 * WHY THIS FILE IS SO CAREFUL ABOUT THE WORD `await`
 *
 * Since JavaScript runs one piece of code at a time, a function running straight through cannot be
 * interrupted by another request; it only steps aside at an `await`, and only then can another
 * request run before it picks up where it left off. That gives one simple, strong rule this file is
 * built around:
 *
 *     Never `await` between reading a session and writing it back.
 *
 * Obey it and a read-then-write is effectively indivisible, so two devices can never both read
 * "this session is unpaid" and both go on to charge it — no locks required. Two functions here have
 * to `await` anyway, because they call the payment provider across a network (`complete` and
 * `get`), and both handle it the same way: once the `await` finishes, the copy of the session they
 * were holding may be minutes out of date, so they throw it away, read the session fresh out of the
 * map, and check it is still in the state their write assumes — leaving it alone if not.
 *
 * Checking the status is enough on its own, which looks too easy until you notice that a session's
 * status only ever moves forward and can never come back:
 *
 *     ACTIVE ──> PAYMENT_PENDING ──> COMPLETED
 *        │              └──────────> FAILED
 *        ├──> EXPIRED
 *        └──> FAILED
 *
 * ACTIVE is only ever set at creation, PAYMENT_PENDING is only ever reached from ACTIVE, and
 * COMPLETED, EXPIRED and FAILED are endings that lead nowhere. So "is this session still
 * PAYMENT_PENDING?" is not just a question about right now — it also proves nothing has happened
 * since we looked. invariants.ts enforces that shape on every write, so if someone later adds a
 * transition that breaks it, the tests fail immediately instead of this reasoning quietly going
 * wrong.
 *
 *
 * WHAT `deps` IS
 *
 * Since this file must be testable without real infrastructure, everything it needs from the
 * outside world — the clock, inventory, pricing, the payment provider — arrives as the `deps`
 * argument (typed in types.ts) and nothing here calls `Date.now()` or reaches for a global. That is
 * what lets the tests hand it a clock they can fast-forward and a provider that fails on command,
 * and it is why every test in tests/ runs in milliseconds with no server and no mocking library.
 */
export function createCheckout(deps: Deps) {
  // The entire database. Since the service never assumes its storage is a Map, a real deployment
  // swaps this for Postgres and nothing else in this file changes shape — see the migration note
  // at the bottom of README.md.
  const db = new Map<string, Session>();

  // Which sessions have already had a "your hold is about to run out" notice sent. Since this is
  // bookkeeping for the notifier rather than part of the session itself, it lives beside the data
  // rather than inside it, and its only job is to make sure the notice goes out once rather than on
  // every page refresh.
  const notified = new Set<string>();

  // ---------- helpers ----------

  /**
   * REJECT AN OPERATION.
   *
   * Since a client that gets turned down should never have to make a second request to find out
   * what is true, every rejection carries the session as it actually is right now, not just an
   * error code — so the client already has the answer and can redraw from it. See src/lib/respond.ts,
   * which turns this into an HTTP response, and src/app/_components/RecoveryState.tsx, which redraws.
   */
  const fail = (code: CheckoutError["code"], s?: Session, extra?: Record<string, unknown>): never => {
    throw new CheckoutError(code, s, extra);
  };

  /**
   * THE ONE AND ONLY PLACE A SESSION GETS WRITTEN.
   *
   * Since a forgotten version bump or an impossible session would be a nasty bug to chase down
   * later, every write is routed through this single function, which is worth its small ceremony
   * for three reasons: `version` goes up exactly once per change automatically, so no caller can
   * forget (and forgetting would quietly break the safety check in `complete`); every write is
   * checked against invariants.ts *before* it is stored, so a bug shows up here as a loud error
   * rather than three screens later; and there is exactly one place to look to see what "saving"
   * means in this app.
   */
  function put(next: Session): Session {
    const s = { ...next, version: next.version + 1 };
    assertTransition(db.get(s.id), s);
    assertInvariants(s, deps.clock.now(), deps.inventory.salesCutoff(s.listingId));
    db.set(s.id, s);
    return s;
  }

  /**
   * END A SESSION AND PUT ITS SEATS BACK ON SALE.
   *
   * Since giving the seats back and recording why are really one event, this needs to do both in a
   * single function that never pauses. If they were two steps with an `await` between them, a crash
   * in the middle would leave seats that no session is holding and no fan can buy — the exact
   * failure described in decision 1 of docs/decisions.md.
   */
  function release(
    s: Session,
    to: { status: "EXPIRED" } | { status: "FAILED"; failReason: FailReason; unresolvedIntentId?: string },
  ): Session {
    deps.inventory.release(s.listingId, s.quantity);
    const next = put({ ...strip(s), ...to });
    deps.events.emit(to.status === "EXPIRED" ? "hold_expired" : "session_failed", {
      sessionId: s.id,
      reason: to.status === "FAILED" ? to.failReason : undefined,
    });
    return next;
  }

  /**
   * REMOVE EVERY FIELD THAT BELONGS TO ONE SPECIFIC STATUS, LEAVING ONLY THE COMMON FIELDS.
   *
   * Since each status in the Session type owns its own extra fields — COMPLETED an `orderId`, FAILED
   * a `failReason`, PAYMENT_PENDING the payment's ID — moving a session from one status to another
   * by copying with `...` and overriding would also copy the *old* status's extra fields: spread a
   * COMPLETED session into a FAILED one and you get a failed session that still carries an order ID,
   * which the type system cannot catch because the spread happens at runtime. So every status change
   * goes through here first and starts from a clean slate.
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
   * WRITE DOWN WHAT THE PAYMENT PROVIDER TOLD US ABOUT A SESSION THAT WAS WAITING ON A CHARGE.
   *
   * Since every caller reaches this only after `await`ing the payment provider — so the session they
   * were holding is a photograph taken before the wait and may be badly out of date — this takes an
   * *ID* rather than a session object, and the first thing it does is read the session again and
   * check it is still waiting on a payment. If it isn't, somebody else already finished the job
   * while we were on the phone, and we quietly leave their answer alone.
   *
   * The bug this prevents is not obvious. Suppose a fan has the checkout open on a laptop and a
   * phone with a charge in flight, and both screens refresh at the same moment: both ask the
   * provider, both hear "declined", and without this re-read both would run `release` and hand the
   * same two seats back twice, so a four-seat listing would believe it had six. The same shape with
   * a successful charge would mint two order IDs for one payment. tests/concurrency.test.ts has this
   * exact scenario and fails if the check is removed.
   */
  function settle(id: string, outcome: PaymentOutcome): Session {
    const s = db.get(id) ?? fail("NOT_FOUND");
    if (s.status !== "PAYMENT_PENDING") {
      // Somebody settled this payment before we did, so their answer stands and ours is dropped.
      // That is almost always harmless, since both answers came from the same provider — except in
      // one case: if we just learned the charge SUCCEEDED but the session was already written off as
      // failed (the pending timeout below can do that while a slow charge is still in flight), the
      // fan's card was charged for seats that went back on sale. A refund is owed, so
      // reconcileChargedButFailed issues it; it only fires while the intent is still marked
      // unresolved, so it cannot pay twice.
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
      // Time is up, but the outcome is still "unknown" and the charge may yet have landed, so this
      // keeps the intent's reference on the failed session for a later read to ask about again. See
      // settleFailed.
      return release(s, { status: "FAILED", failReason: "PENDING_TIMEOUT", unresolvedIntentId: s.paymentIntentId });
    return s;
  }

  /**
   * A CHARGE WE HAD WRITTEN OFF ACTUALLY WENT THROUGH — GIVE THE MONEY BACK.
   *
   * Since a charge can be confirmed after we already failed the session — reached two ways that mean
   * the same thing: settle seeing a late "ok", or a later read of the failed session hearing "ok"
   * from the provider — this needs to make the fan whole, because they paid for seats that are back
   * on sale. It refunds, records the conflict for anyone watching, and clears the reference, for the
   * reason that clearing it is what stops any subsequent read from refunding the same charge again.
   */
  function reconcileChargedButFailed(s: SessionOf<"FAILED">): Session {
    deps.payments.refund(s.unresolvedIntentId!);
    deps.events.emit("reconcile_conflict", { sessionId: s.id, intentId: s.unresolvedIntentId, status: s.status });
    deps.events.emit("refund_issued", { sessionId: s.id, intentId: s.unresolvedIntentId });
    return put({ ...s, unresolvedIntentId: undefined });
  }

  /**
   * RESOLVE A FAILED SESSION THAT IS STILL CARRYING AN UNCERTAIN PAYMENT REFERENCE.
   *
   * Since this is the mirror image of `settle` and its callers also reach it only after awaiting the
   * provider, it likewise takes an id and re-reads rather than trusting the snapshot it was handed.
   * It is implemented as a three-way choice for a clear reason: if the provider now says the charge
   * landed, the fan is refunded; if it says declined, no money moved and the reference can be
   * forgotten; and if it still cannot say, the reference is kept so the next read can ask again.
   */
  function settleFailed(id: string, outcome: PaymentOutcome): Session {
    const s = db.get(id) ?? fail("NOT_FOUND");
    if (s.status !== "FAILED" || !s.unresolvedIntentId) return s;
    if (outcome === "ok") return reconcileChargedButFailed(s);
    if (outcome === "declined") return put({ ...s, unresolvedIntentId: undefined });
    return s;
  }

  /**
   * OTHER LISTINGS TO OFFER A FAN WHOSE OWN LISTING DISAPPEARED OUT FROM UNDER THEM.
   *
   * Since "your tickets are gone" with no next step is a dead end, this produces alternatives — but
   * only when the session failed specifically because the seller pulled the listing, because that is
   * the one case where the fan has lost their seats through no action of their own. Both the error
   * response and the failure screen carry these so the fan has something to buy instead. Rendered by
   * src/app/_components/RecoveryState.tsx and fetched for pages by src/lib/load-checkout-page.ts.
   */
  const alternativesFor = (s: Session) =>
    s.status === "FAILED" && s.failReason === "INVENTORY_WITHDRAWN"
      ? { alternatives: deps.inventory.alternatives(s.listingId) }
      : undefined;

  /**
   * FIND HOLDS WHOSE TIME HAS RUN OUT (AND ABANDONED PAYMENTS) AND PUT THEIR SEATS BACK.
   *
   * Since this app deliberately has no background job that expires holds on a timer — a session is
   * treated as expired the moment anybody reads it after its deadline (see `get` below), which is a
   * good design because there is never a window where the clock has passed but a cleanup job hasn't
   * run — one gap remains, and this function is the patch for it. The count of seats still for sale
   * is a plain number that goes down when a hold is taken and up when one is released, and that
   * number only learns a hold has lapsed when somebody reads the session — but the one session
   * nobody will ever read again belongs to the fan who closed the tab and walked away, whose seats
   * would then sit unsellable forever.
   *
   * So this needs to check the deadlines on behalf of the person who actually cares, and that is not
   * the fan who abandoned the hold but the next fan trying to buy — which is why it runs at the top
   * of `create` and on the two pages that display seat counts (src/app/page.tsx and
   * src/app/listing/[id]/page.tsx). It is async because it does more than free lapsed ACTIVE holds:
   * it also reconciles abandoned payments, which requires asking the provider.
   */
  async function sweepExpired(listingId?: string): Promise<void> {
    const now = deps.clock.now();
    for (const s of [...db.values()]) {
      if (listingId !== undefined && s.listingId !== listingId) continue;
      if (s.status === "ACTIVE" && now >= s.holdExpiresAt) {
        release(s, { status: "EXPIRED" });
      } else if (s.status === "PAYMENT_PENDING" && now - s.pendingSince > deps.policy.pendingTimeoutMs) {
        // Since this is a payment nobody is waiting on any more, its seats must not stay held on a
        // charge the buyer walked away from, so we ask the provider and settle it here. This is the
        // fix for a pending session that would otherwise hold inventory until someone happened to
        // read it — and nobody reads the session of a fan who closed the tab. settle re-reads after
        // the await, as always.
        settle(s.id, await deps.payments.status(s.paymentIntentId));
      } else if (s.status === "FAILED" && s.unresolvedIntentId) {
        // Since this is a written-off payment whose fate we never confirmed, we check once more so
        // that a charge which landed after we gave up is refunded even if the buyer never returns.
        settleFailed(s.id, await deps.payments.status(s.unresolvedIntentId));
      }
    }
  }

  // ---------- operations ----------

  /**
   * START A CHECKOUT: take the seats, quote a price, and set the deadline.
   *
   * Reached from the "Buy" form on src/app/listing/[id]/page.tsx (via the Server Action in
   * src/app/actions.ts) and from POST /api/sessions.
   */
  async function create(input: CreateInput): Promise<Session> {
    // Since there are two front doors into this function — the HTTP API and the Server Action — and
    // a rule enforced in only one doorway is not really enforced, the request is validated here in
    // the domain rather than in the route. The quantity check matters especially because
    // `Number("abc")` is NaN and every comparison with NaN is false, so a NaN quantity would slip
    // through `available < quantity` and silently corrupt the seat count.
    if (typeof input.listingId !== "string" || input.listingId === "") fail("INVALID_REQUEST");
    if (!Number.isInteger(input.quantity) || input.quantity < 1) fail("INVALID_REQUEST");
    const now = deps.clock.now();
    // Give back any seats whose holds have quietly run out, so we count what is really available
    // rather than what was available before some other fan wandered off. Running this first also
    // means the dedup check below only ever sees genuinely-live holds — a lapsed one is already gone.
    await sweepExpired(input.listingId);

    // Since one browser repeating Buy → Start → Back would otherwise reserve a fresh set of seats
    // every time — draining a listing through separate sessions, which the per-attempt idempotency
    // key does nothing to stop because each is a different session — a browser that already holds a
    // live session for this listing gets that same session back instead of a new hold. This makes
    // repeating the flow idempotent: it resumes the existing checkout rather than creating another.
    // A PENDING hold counts as live too, so someone mid-payment is returned to it, not sent to a
    // second one. clientId is optional; a caller without the cookie (raw API, old test) skips this.
    if (input.clientId) {
      const existing = [...db.values()].find(
        (x) => x.clientId === input.clientId && x.listingId === input.listingId && (x.status === "ACTIVE" || x.status === "PAYMENT_PENDING"),
      );
      if (existing) {
        deps.events.emit("hold_resumed_same_client", { sessionId: existing.id, clientId: input.clientId });
        return existing;
      }
    }

    // Has the seller pulled this listing entirely?
    if (!deps.inventory.backs(input.listingId)) fail("INVENTORY_WITHDRAWN");

    // Since ticket sales stop shortly before an event starts, there is no point beginning a checkout
    // past that moment: the deadline we would hand out is `min(now + hold window, cutoff)`, and once
    // `now` is past the cutoff that works out to a time in the past — so the fan would get a
    // live-looking checkout page whose first refresh says "your hold ended", for a hold that was
    // never alive for a single second. This is checked before we take any seats, so a refused
    // checkout never has to give anything back.
    const cutoff = deps.inventory.salesCutoff(input.listingId);
    if (now >= cutoff) fail("SALES_CLOSED");

    // Now actually take the seats. This can still fail if someone else got the last ones between the
    // page rendering and this button press.
    if (!deps.inventory.hold(input.listingId, input.quantity)) fail("SOLD_OUT");

    const price = deps.pricing.current(input.listingId);
    const s = put({
      id: deps.ids.next("cs"),
      listingId: input.listingId,
      quantity: input.quantity,
      quotedTotal: price.total * input.quantity,
      priceVersion: price.version,
      // How long the fan gets, from two rules combined: the hold window itself shrinks as the event
      // gets closer (a ten-minute hold is fine three days out and absurd eight minutes before
      // kickoff — see `policy.holdWindowMs` in stubs.ts), and whatever that works out to, the hold
      // can never outlive the moment sales stop, so we take whichever comes first.
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
   * LOOK UP A SESSION AND BRING IT UP TO DATE BEFORE HANDING IT BACK.
   *
   * Since there is no separate "resume" concept anywhere in this codebase — resuming is just reading
   * — this is the function behind it: both surfaces call it through src/lib/load-checkout-page.ts,
   * and GET /api/sessions/:id calls it directly.
   *
   * Reading is also when a session catches up with reality, because three things can go stale while
   * nobody is looking:
   *
   *   1. The hold's deadline passed. The session is expired and the seats go back.
   *   2. The seller pulled the listing. The session failed and the seats go back.
   *   3. A payment was in flight. We ask the provider how it went and record the answer.
   *
   * Only the third needs to leave the building, which is why this function is async while the first
   * two branches finish without ever pausing.
   */
  async function get(id: string, seenOn?: CreateInput["surface"]): Promise<Session> {
    let s = db.get(id) ?? fail("NOT_FOUND");
    const now = deps.clock.now();

    // Since a session waiting on a payment must be immune to the clock — if the deadline could fire
    // mid-charge we would hand the seats to somebody else while the first fan's card was being
    // charged, and sell the same seats twice — only ACTIVE sessions expire here. A payment in flight
    // ends when the provider says so, never when the timer says so.
    if (s.status === "ACTIVE" && now >= s.holdExpiresAt) s = release(s, { status: "EXPIRED" });
    else if (s.status === "ACTIVE" && !deps.inventory.backs(s.listingId))
      s = release(s, { status: "FAILED", failReason: "INVENTORY_WITHDRAWN" });
    // The `await` below is the only pause in this function, and everything `s` holds is stale from
    // here on — which is exactly why `settle` re-reads instead of trusting what we pass it.
    else if (s.status === "PAYMENT_PENDING") s = settle(s.id, await deps.payments.status(s.paymentIntentId));
    // A payment we gave up on may have landed since, so we ask again to refund a late success rather
    // than lose it. It only fires while the reference is still unresolved, so it is a no-op once
    // reconciled — this is the read-path half of the same reconciliation the sweep does.
    else if (s.status === "FAILED" && s.unresolvedIntentId) s = settleFailed(s.id, await deps.payments.status(s.unresolvedIntentId));

    if (seenOn && seenOn !== s.lastSeenOn) {
      deps.events.emit("session_resumed", { sessionId: s.id, surface: seenOn, fromSurface: s.lastSeenOn, ageMs: now - s.createdAt });
      // Since merely glancing at the checkout on a phone changes nothing about it, this update is
      // written straight to the map instead of through `put` — the one deliberate exception in this
      // file — because `put` would bump `version`, and `version` is what tells a device "your copy
      // is out of date". If a phone read bumped it, the laptop's Pay button would start failing for
      // no reason the fan could understand. This field is for our analytics, not for them.
      s = { ...s, lastSeenOn: seenOn };
      db.set(s.id, s);
    }

    // Nudge the fan before their hold runs out. Since continuity only pays off if something brings
    // people back — a push, an email, a "you left something" banner — a real system would have a
    // scheduler fire this at a set time; here the clock is a stub that tests fast-forward at will, so
    // there is no scheduler to hook into and the next read is the honest substitute. The `notified`
    // set keeps it to one notice per session no matter how often the page is refreshed. The notifier
    // itself is in stubs.ts and just writes to the event log; the deep link it would carry is the one
    // src/app/deeplink/[id]/route.ts serves.
    if (s.status === "ACTIVE" && now >= s.holdExpiresAt - deps.policy.notifyLeadMs && !notified.has(s.id)) {
      notified.add(s.id);
      deps.notifier.holdExpiringSoon(s.id);
    }
    return s;
  }

  /**
   * READ THE SESSION AS IT IS AT THIS INSTANT, WITH NO UPDATING AND NO PAUSING.
   *
   * Since `get` above is async, any function that called it has already stepped aside once and what
   * it got back may be out of date, so every function that intends to *change* a session calls this
   * immediately before doing so and then does its checking and its writing without a single `await`
   * in between. That unbroken stretch is what makes the change safe — see the long note at the top
   * of this file.
   */
  function current(id: string): Session {
    return db.get(id) ?? fail("NOT_FOUND");
  }

  /**
   * HAS THE LISTING'S PRICE MOVED SINCE WE QUOTED THIS FAN?
   *
   * Since the promise this app makes is that the amount charged is always an amount the fan was shown
   * and agreed to, the session itself is never updated behind their back; this only *reports* a
   * difference, returning the old total, the new total, and the new price version, or nothing if the
   * quote is still current. `acceptPrice` below is the only thing that actually records the fan's
   * agreement to a new price. Drawn as the "the price changed while you were away" panel in
   * src/app/_components/RecoveryState.tsx.
   */
  function priceChange(s: Session) {
    if (s.status !== "ACTIVE") return undefined;
    const live = deps.pricing.current(s.listingId);
    if (live.version === s.priceVersion) return undefined;
    return { from: s.quotedTotal, to: live.total * s.quantity, newPriceVersion: live.version };
  }

  /**
   * RECORD THAT THE FAN HAS SEEN THE NEW PRICE AND AGREED TO IT.
   *
   * Reached from the "Accept" button on the price-change panel. After this the session is quoting
   * the new total and `complete` will go through.
   */
  async function acceptPrice(id: string, input: AcceptPriceInput): Promise<Session> {
    await get(id, input.surface); // bring the session up to date first (this may pause)
    const s = current(id); // now read it fresh — from here down, no pausing
    if (s.status !== "ACTIVE") fail(statusError(s), s, alternativesFor(s));
    if (input.version !== s.version) fail("STALE_VERSION", s);
    const live = deps.pricing.current(s.listingId);
    if (input.priceVersion !== live.version) fail("PRICE_CHANGED", s, { priceChange: priceChange(s) });
    const next = put({ ...s, quotedTotal: live.total * s.quantity, priceVersion: live.version });
    deps.events.emit("price_change_accepted", { sessionId: s.id, from: s.quotedTotal, to: next.quotedTotal });
    return next;
  }

  /**
   * THE SESSION `complete` HANDS BACK WHEN IT IS NOT REJECTING.
   *
   * Since a client that checks the HTTP status code before reading the body would read a 200 as a
   * completed purchase, `complete` must return normally only when the session it hands back is
   * genuinely an answer to what the fan asked: COMPLETED (their money moved) or PAYMENT_PENDING (we
   * are still finding out). Anything else ended for a reason unrelated to this press — most likely
   * the pending timeout wrote the session off while their charge was in flight — so this turns those
   * into rejections, using the same code every other "this session cannot be acted on" path uses.
   * The screen is identical either way, because RecoveryState.tsx renders from status and both
   * routes carry the session; the point is that the API stops contradicting itself about what a
   * failure looks like.
   */
  function answer(s: Session): Session {
    if (s.status === "COMPLETED" || s.status === "PAYMENT_PENDING") return s;
    return fail(statusError(s), s, alternativesFor(s));
  }

  /**
   * CHARGE THE CARD AND TURN THE HOLD INTO AN ORDER. This is the hard one.
   *
   * Since this is the only function that has to call out to a payment provider — which means
   * pausing, which means other requests get to run in the middle of it — almost every difficult
   * question about this app is really a question about the few lines below.
   *
   * There are two completely different ways a fan can end up asking to pay twice, and mixing them up
   * gives you either a double charge or a fan stuck staring at an error, so each needs its own
   * answer:
   *
   *   TWO DEVICES, TWO SEPARATE ATTEMPTS. The laptop and the phone both have the checkout open and
   *   both press Pay. These are genuinely two different attempts by a confused person: one should go
   *   through and the other should be told "you're already paying on your other device". The status
   *   check below does this — whoever gets there first flips the session to PAYMENT_PENDING, and the
   *   second finds it no longer ACTIVE.
   *
   *   ONE DEVICE, ONE ATTEMPT, SENT TWICE. The fan double-clicks, or the network drops the reply and
   *   the browser retries. This is one attempt that happens to have arrived twice, and the right
   *   answer is to pretend the second never happened and hand back the first's result. The
   *   idempotency key does this: the browser carries one value per rendered form (minted in
   *   src/lib/load-checkout-page.ts, carried by src/app/_components/PayForm.tsx), so both copies of
   *   one attempt share a key.
   *
   * Neither mechanism can do the other's job — the status check would tell a retry it is competing
   * with itself, and the key cannot link two devices because they hold different keys — which is why
   * both are here.
   */
  async function complete(id: string, input: CompleteInput): Promise<Session> {
    // Since the idempotency key used to only need to be truthy and the route reached it through
    // `String(...)`, it had a sharp edge worth guarding against: `String({})` is "[object Object]",
    // so every caller who sent a non-string key landed on the *same* key, and two genuinely
    // different attempts would collide with the second handed the first one's order. So the key must
    // be a real, non-empty string, and it is capped in length because it is stored on the session for
    // the session's whole life, so an unbounded one would be a memory leak that still answered 200.
    if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey || input.idempotencyKey.length > 200)
      fail("INVALID_REQUEST");

    // Since the stub ignores the payment token, a missing token would silently "work" — and the day
    // this is wired to a real provider, that same path would attempt a charge against a placeholder.
    // So the token is required with no default, because this is the one field where a fallback is
    // actively dangerous.
    if (typeof input.paymentToken !== "string" || !input.paymentToken) fail("INVALID_REQUEST");
    await get(id, input.surface); // bring the session up to date; this may pause
    const s = current(id); // ---- from here to the `put` below: no pausing allowed ----

    // Since this exact attempt may have been seen before, we check the replay table first and, if we
    // find it, hand back the same answer without going near the card. Because the key is recorded
    // below at the same instant the session flips to PAYMENT_PENDING, this also catches the case
    // where the first copy of the attempt is still in flight, which then gets a calm "we're
    // confirming your payment" rather than a confusing error. It uses `Object.hasOwn` rather than a
    // bare lookup because the idempotency map is a plain object, so a key like "constructor" or
    // "toString" would otherwise match an inherited property and a first-ever attempt with that key
    // would be turned away as a replay of something that never happened.
    const replayed = Object.hasOwn(s.idempotency, input.idempotencyKey) ? s.idempotency[input.idempotencyKey] : undefined;
    if (replayed !== undefined) {
      // Hand back the same answer as last time, including the same failure, because returning a
      // cheerful 200 for a retry of something that was declined would read as success.
      if (replayed === "declined") fail("PAYMENT_DECLINED", s);
      return answer(s);
    }

    // A different attempt entirely. Since every rejection below carries the truth about the session,
    // whichever screen the fan is on can redraw itself correctly from it.
    if (s.status === "PAYMENT_PENDING") fail("IN_PROGRESS_ELSEWHERE", s);
    if (s.status !== "ACTIVE") fail(statusError(s), s, alternativesFor(s));
    // Since every response tells the client the session's current version and every request has to
    // send back the number it was looking at, a mismatch means this press was made against
    // information the fan can no longer see — maybe the other device accepted a price change — so we
    // refuse and hand back the current session for their screen to catch up on.
    if (input.version !== s.version) fail("STALE_VERSION", s);

    // Since the price could have moved in two independent ways, it is checked twice and both checks
    // are necessary: did this device see the price the session is holding (input vs session), and is
    // the price the session is holding still the real one (session vs listing)? The first alone
    // leaves a gap — the fan loads the page, the seller changes the price, the fan presses Pay, and
    // the version numbers still agree because nothing about the session changed while the quote went
    // stale — which the second check closes.
    const live = deps.pricing.current(s.listingId);
    if (input.priceVersion !== s.priceVersion || s.priceVersion !== live.version)
      fail("PRICE_CHANGED", s, { priceChange: priceChange(s) ?? { from: s.quotedTotal, to: s.quotedTotal, newPriceVersion: s.priceVersion } });

    // This write is the moment that decides who gets to pay. Since everything from `current(id)`
    // down to here ran without a single pause, no other request could have touched the session in
    // between, so the checks above were still true at the instant this write lands — and flipping the
    // status to PAYMENT_PENDING now closes the door, so any other attempt arriving from here on finds
    // a session that is no longer ACTIVE and gets turned away.
    const pending = put({
      ...strip(s),
      status: "PAYMENT_PENDING",

      // The payment gets an ID before the charge is attempted, reusing the session's own ID, and two
      // things follow. First, it is recorded, so if this server dies one line from now the fan's card
      // may have been charged with nobody writing it down — and the next read of this session can ask
      // the provider "what happened to payment cs_0001?" and find out (that recovery is in `get`
      // above). Second, because the ID is derived from the session rather than generated fresh,
      // asking the provider to charge it twice cannot produce two charges, since providers treat a
      // repeated ID as a repeat of the same request.
      paymentIntentId: s.id,
      pendingSince: deps.clock.now(),

      // The idempotency key is claimed here, in the same write, rather than after the charge comes
      // back — because if we waited, a double-click would arrive while the first copy was still
      // talking to the provider, find no key recorded yet, and be told it was competing with another
      // device about itself. "unknown" is a placeholder meaning "this attempt is underway and we
      // don't yet know how it went", which is exactly what a second copy should be told; the real
      // outcome overwrites it below.
      idempotency: { ...s.idempotency, [input.idempotencyKey]: "unknown" },
    }) as SessionOf<"PAYMENT_PENDING">;
    deps.events.emit("payment_started", { sessionId: s.id, surface: input.surface });

    // The pause. Other requests run during this, which is the entire reason for the care taken above.
    // The seats are safe because the session is no longer ACTIVE, so the clock can no longer expire
    // it out from under the charge.
    const outcome = await deps.payments
      .charge(pending.paymentIntentId, input.paymentToken)
      // Since a thrown call — a dropped connection, a provider timeout — tells us nothing about
      // whether the card was actually charged, treating it as a failure is the single most expensive
      // mistake available here: a fan told "that didn't work, try again" types their card in a second
      // time and gets billed twice. So a dead connection becomes "unknown", the seats stay held, the
      // fan is told we are still confirming, and the next read of the session asks the provider what
      // actually happened.
      .catch((): PaymentOutcome => "unknown");

    // Write down how it went. `settle` re-reads the session first, because that `await` means
    // somebody else may have resolved this payment while we waited.
    const settled = settle(id, outcome);

    // Record the outcome against this attempt's key, so a retry gets this same answer back instead
    // of starting a second charge.
    const withReplay = put({ ...settled, idempotency: { ...settled.idempotency, [input.idempotencyKey]: outcome } });

    // A declined card is a failure the fan can act on — it is safe to try another card, because we
    // know for certain no money moved, which is what separates it from "unknown" (which `answer`
    // lets through with the session still pending).
    if (outcome === "declined") fail("PAYMENT_DECLINED", withReplay);
    return answer(withReplay);
  }

  /**
   * TRY AGAIN AFTER A HOLD RAN OUT.
   *
   * Since an expired session is finished for good, this does not revive it: it starts a brand new
   * session for the same seats and records a pointer from the old one to the new, which is what lets
   * a stale link or an old notification still lead somewhere useful instead of a dead end. Calling it
   * twice returns the same new session rather than holding a second set of seats, which matters
   * because "Try again" is a button a frustrated person presses repeatedly.
   */
  async function rehold(id: string): Promise<Session> {
    const old = db.get(id) ?? fail("NOT_FOUND");
    if (old.status !== "EXPIRED") return fail(statusError(old), old, alternativesFor(old));
    if (old.successorSessionId) return db.get(old.successorSessionId)!;
    // Carry the original browser's identity onto the successor, so the new hold is still owned by
    // the same client for dedup and for the home-page "resume" banner.
    const next = await create({ listingId: old.listingId, quantity: old.quantity, surface: old.lastSeenOn, clientId: old.clientId });
    put({ ...old, successorSessionId: next.id });
    return next;
  }

  /**
   * PICK THE ERROR CODE THAT BEST EXPLAINS WHY A SESSION CANNOT BE ACTED ON RIGHT NOW.
   *
   * Since the fan sees a screen drawn from the session that travels alongside it, this code is not
   * for them — it only decides which wording and which button that screen shows. See the switch in
   * src/app/_components/RecoveryState.tsx.
   */
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
    alternativesFor,
    /** Call before showing how many seats are left, so lapsed holds are already back. */
    sweepExpired,
    /**
     * Holds that are still live, newest first.
     *
     * Since a notification is only one way back into an abandoned checkout, this gives the home page
     * (src/app/page.tsx) another that needs no infrastructure at all: a "you have a hold in progress"
     * banner with its countdown, waiting for the fan when they next open the site. This only reads
     * and never changes anything.
     *
     * A `clientId` scopes the list to one browser's own holds, which is what the home page passes so
     * the banner shows the visitor their hold and not somebody else's. Called without one it returns
     * every live hold, which is what the tests and the curl demo (no cookie) rely on.
     */
    resumable: (clientId?: string) => {
      const now = deps.clock.now();
      return [...db.values()]
        .filter((s) => s.status === "ACTIVE" && now < s.holdExpiresAt && (clientId === undefined || s.clientId === clientId))
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    // The following are used by the tests and by GET /api/debug/state, and are named with a leading
    // underscore because nothing in the real application should be calling them.
    /** Test and debug only. */
    _all: () => [...db.values()],
    _reset: () => { db.clear(); notified.clear(); },
    _isTerminal: (s: Session) => TERMINAL.has(s.status),
  };
}

export type Checkout = ReturnType<typeof createCheckout>;

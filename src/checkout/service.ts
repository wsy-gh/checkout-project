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
 * This is the only file that decides what may happen to a checkout session. Everything else
 * is a thin wrapper around it: the HTTP routes in src/app/api/sessions/ call these functions
 * and turn the result into JSON, the Server Actions in src/app/actions.ts call the same
 * functions for the web forms, and the pages just draw whatever session comes back.
 *
 *
 * WHAT A SESSION IS
 *
 * When a fan starts checkout we take seats out of the available pool and write down a
 * record: which listing, how many seats, the price we quoted them, and the moment those
 * seats go back if nobody has paid. That record is the session. The fan's browser is handed
 * its ID and nothing else.
 *
 * That is the whole trick behind "start on web, finish on your phone". Nothing has to be
 * copied to the phone, and the two devices never talk to each other. The phone asks the
 * server about the same ID and gets the same answer, because the server is the only place
 * that ever knew anything.
 *
 *
 * WHY THIS FILE IS SO CAREFUL ABOUT THE WORD `await`
 *
 * JavaScript runs one piece of code at a time. While a function is running straight through,
 * no other request can interrupt it. A function only steps aside at an `await`, and then
 * another request gets to run before it picks up where it left off.
 *
 * That gives us a simple and very strong rule:
 *
 *     Never `await` between reading a session and writing it back.
 *
 * Obey that and a read-then-write is effectively indivisible, so two devices can never both
 * read "this session is unpaid" and both go on to charge it. No locks required.
 *
 * Two functions here have to `await` anyway, because they call the payment provider across a
 * network: `complete` and `get`. Both handle it the same way. Once the `await` finishes, the
 * copy of the session they were holding may be minutes old and wrong, so they throw it away,
 * read the session fresh out of the map, and check it is still in the state their write
 * assumes. If something else changed it in the meantime, they leave it alone.
 *
 * Checking the status is enough on its own, which looks too easy until you notice that a
 * session's status only ever moves forward and can never come back:
 *
 *     ACTIVE ──> PAYMENT_PENDING ──> COMPLETED
 *        │              └──────────> FAILED
 *        ├──> EXPIRED
 *        └──> FAILED
 *
 * ACTIVE is only ever set when a session is first created. PAYMENT_PENDING is only ever
 * reached from ACTIVE. COMPLETED, EXPIRED and FAILED are endings — nothing leads out of
 * them. So "is this session still PAYMENT_PENDING?" is not just a question about right now;
 * it also proves nothing has happened since we looked. invariants.ts enforces that shape on
 * every single write, so if someone later adds a transition that breaks it, the tests fail
 * immediately instead of this reasoning quietly becoming wrong.
 *
 *
 * WHAT `deps` IS
 *
 * Everything this file needs from the outside world — the clock, inventory, pricing, the
 * payment provider — arrives as the `deps` argument, typed in types.ts. Nothing here calls
 * `Date.now()` or reaches for a global. That is what lets the tests hand it a clock they can
 * fast-forward and a payment provider that fails on command, and it is why every test in
 * tests/ runs in milliseconds with no server and no mocking library.
 */
export function createCheckout(deps: Deps) {
  // The entire database. A real deployment swaps this for Postgres and nothing else in this
  // file changes shape — see the note at the bottom of README.md about that migration.
  const db = new Map<string, Session>();

  // Which sessions have already had a "your hold is about to run out" notice sent. This is
  // bookkeeping for the notifier, not part of the session itself, so it lives beside the
  // data rather than inside it. Its only job is to make sure we send that notice once rather
  // than on every page refresh.
  const notified = new Set<string>();

  // ---------- helpers ----------

  /**
   * Reject an operation.
   *
   * Every rejection carries the session as it actually is right now, not just an error code.
   * That is deliberate: it means a client that gets turned down never has to make a second
   * request to find out what is true. It already has the answer and can redraw the screen
   * from it. See src/lib/respond.ts, which turns this into an HTTP response, and
   * src/app/_components/RecoveryState.tsx, which does the redrawing.
   */
  const fail = (code: CheckoutError["code"], s?: Session, extra?: Record<string, unknown>): never => {
    throw new CheckoutError(code, s, extra);
  };

  /**
   * The one and only place a session gets written.
   *
   * Routing every write through a single function is worth the small amount of ceremony:
   *
   *   - `version` goes up exactly once per change, automatically. No caller can forget, and
   *     forgetting would quietly break the safety check in `complete` further down.
   *   - Every write is checked against the rules in invariants.ts *before* it is stored, so a
   *     bug shows up here as a loud error rather than three screens later as a session in an
   *     impossible state.
   *   - If you want to know what "saving" means in this app, there is exactly one place to
   *     look.
   */
  function put(next: Session): Session {
    const s = { ...next, version: next.version + 1 };
    assertTransition(db.get(s.id), s);
    assertInvariants(s, deps.clock.now(), deps.inventory.salesCutoff(s.listingId));
    db.set(s.id, s);
    return s;
  }

  /**
   * End a session and put its seats back on sale.
   *
   * Giving the seats back and recording why are the same event, so they happen together in
   * one function that never pauses. If these were two separate steps with an `await` between
   * them, a crash in the middle would leave seats that no session is holding and no fan can
   * buy — the exact failure described in decision 1 of docs/decisions.md.
   */
  function release(s: Session, to: { status: "EXPIRED" } | { status: "FAILED"; failReason: FailReason }): Session {
    deps.inventory.release(s.listingId, s.quantity);
    const next = put({ ...strip(s), ...to });
    deps.events.emit(to.status === "EXPIRED" ? "hold_expired" : "session_failed", {
      sessionId: s.id,
      reason: to.status === "FAILED" ? to.failReason : undefined,
    });
    return next;
  }

  /**
   * Remove every field that belongs to one specific status, leaving only the fields common
   * to all of them.
   *
   * The Session type in types.ts gives each status its own extra fields: COMPLETED carries an
   * `orderId`, FAILED carries a `failReason`, PAYMENT_PENDING carries the payment's ID. When
   * we move a session from one status to another we normally copy the old one with `...` and
   * override what changed — but `...` copies the old status's extra fields too. Spread a
   * COMPLETED session into a FAILED one and you get a failed session that still has an order
   * ID attached to it, which is nonsense that the type system cannot catch because the spread
   * happened at runtime.
   *
   * So every status change goes through here first and starts from a clean slate.
   */
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

  /**
   * Write down what the payment provider told us about a session that was waiting on a
   * charge.
   *
   * Notice this takes an ID rather than a session object, which is the important detail.
   * Everyone who calls this got here by `await`ing the payment provider, so the session they
   * were holding onto is a photograph taken before the wait. It may be badly out of date. So
   * the first thing we do is read the session again and check it is still waiting on a
   * payment. If it isn't, somebody else already finished the job while we were on the phone,
   * and we quietly leave their answer alone.
   *
   * Here is the bug this prevents, because it is not obvious. Suppose a fan has the checkout
   * open on a laptop and a phone, and the session is waiting on a charge. Both screens
   * refresh at the same moment. Both ask the provider, both hear "declined", and without this
   * check both would run `release` and hand the seats back — the same two seats returned
   * twice. A listing with four seats would end up believing it had six. The same shape with a
   * successful charge would create two different order IDs for one payment.
   *
   * tests/concurrency.test.ts has this exact scenario, and it fails if you remove the check.
   */
  function settle(id: string, outcome: PaymentOutcome): Session {
    const s = db.get(id) ?? fail("NOT_FOUND");
    if (s.status !== "PAYMENT_PENDING") {
      // Somebody settled this payment before we did, so their answer stands and ours is
      // dropped. That is almost always harmless — both answers came from the same provider.
      //
      // Except in one case. If we just learned the charge SUCCEEDED but the session has
      // already been written off as failed (the "we waited too long" timeout below can do
      // that while a slow charge is still in flight), then the fan's card was charged for
      // seats that went back on sale. Nobody is going to notice that on their own, so we log
      // it loudly. A production system has a job that reconciles against the provider and
      // issues the refund; here the event log is standing in for that job.
      if (outcome === "ok" && s.status !== "COMPLETED")
        deps.events.emit("reconcile_conflict", { sessionId: id, status: s.status, outcome });
      return s;
    }
    if (outcome === "ok") {
      const done = put({ ...strip(s), status: "COMPLETED", paymentIntentId: s.paymentIntentId, orderId: deps.ids.next("ord") });
      deps.events.emit("completed", { sessionId: s.id, orderId: (done as SessionOf<"COMPLETED">).orderId });
      return done;
    }
    if (outcome === "declined") return release(s, { status: "FAILED", failReason: "DECLINED" });
    if (deps.clock.now() - s.pendingSince > deps.policy.pendingTimeoutMs)
      return release(s, { status: "FAILED", failReason: "PENDING_TIMEOUT" });
    return s;
  }

  /**
   * Other listings to offer a fan whose own listing disappeared out from under them.
   *
   * Only produces anything when the session failed specifically because the seller pulled the
   * listing. "Your tickets are gone" with no next step is a dead end, so the error response
   * and the failure screen both carry a few things the fan can actually buy instead. Rendered
   * by src/app/_components/RecoveryState.tsx and fetched for pages by src/lib/page-data.ts.
   */
  const alternativesFor = (s: Session) =>
    s.status === "FAILED" && s.failReason === "INVENTORY_WITHDRAWN"
      ? { alternatives: deps.inventory.alternatives(s.listingId) }
      : undefined;

  /**
   * Find holds whose time has run out and put their seats back.
   *
   * This app has no background job that expires holds on a timer. Instead a session is
   * treated as expired the moment anybody looks at it after its deadline — see `get` below.
   * That is a good design because nothing can get out of step: there is no window where the
   * clock has passed but the cleanup job hasn't run yet.
   *
   * It has one gap, though, and this function is the patch for it. The count of seats still
   * for sale is a plain number that goes down when a hold is taken and back up when one is
   * released. That number only finds out a hold has lapsed when somebody reads the session —
   * and the one session nobody will ever read again is the one belonging to the fan who
   * closed the tab and walked away. Their seats would sit unsellable forever.
   *
   * So before anyone asks how many seats are left, we check the deadlines ourselves. The
   * person who cares about an abandoned hold is not the fan who abandoned it; it is the next
   * fan trying to buy. Called at the top of `create` below, and by the two pages that display
   * seat counts (src/app/page.tsx and src/app/listing/[id]/page.tsx).
   */
  function sweepExpired(listingId?: string): void {
    const now = deps.clock.now();
    for (const s of [...db.values()])
      if (s.status === "ACTIVE" && now >= s.holdExpiresAt && (listingId === undefined || s.listingId === listingId))
        release(s, { status: "EXPIRED" });
  }

  // ---------- operations ----------

  /**
   * Start a checkout: take the seats, quote a price, and set the deadline.
   *
   * Reached from the "Buy" form on src/app/listing/[id]/page.tsx (via the Server Action in
   * src/app/actions.ts) and from POST /api/sessions.
   */
  function create(input: CreateInput): Session {
    // Checked here rather than in the route, because there are two front doors into this
    // function — the HTTP API and the Server Action — and a rule enforced in one doorway is
    // a rule that is not really enforced. `Number("abc")` is NaN, and NaN slips through
    // ordinary comparisons like `available < quantity` because every comparison with NaN is
    // false, so an unchecked value here would have silently corrupted the seat count.
    if (typeof input.listingId !== "string" || input.listingId === "") fail("INVALID_REQUEST");
    if (!Number.isInteger(input.quantity) || input.quantity < 1) fail("INVALID_REQUEST");
    const now = deps.clock.now();
    // Give back any seats whose holds have quietly run out, so we are counting what is
    // really available rather than what was available before some other fan wandered off.
    sweepExpired(input.listingId);

    // Has the seller pulled this listing entirely?
    if (!deps.inventory.backs(input.listingId)) fail("INVENTORY_WITHDRAWN");

    // Ticket sales stop shortly before an event starts, not when it starts. Past that
    // moment there is no point beginning a checkout at all: the deadline we would hand out
    // is `min(now + hold window, cutoff)`, and once `now` is past the cutoff that works out
    // to a time in the past. The fan would get a live-looking checkout page whose first
    // refresh says "your hold ended" — for a hold that was never alive for a single second.
    //
    // This is checked before we take any seats, so a refused checkout never has to give
    // anything back.
    const cutoff = deps.inventory.salesCutoff(input.listingId);
    if (now >= cutoff) fail("SALES_CLOSED");

    // Now actually take the seats. This can still fail if someone else got the last ones
    // between the page rendering and this button press.
    if (!deps.inventory.hold(input.listingId, input.quantity)) fail("SOLD_OUT");

    const price = deps.pricing.current(input.listingId);
    const s = put({
      id: deps.ids.next("cs"),
      listingId: input.listingId,
      quantity: input.quantity,
      quotedTotal: price.total * input.quantity,
      priceVersion: price.version,
      // How long the fan gets. Two rules combine here. The hold window itself shrinks as
      // the event gets closer (a ten-minute hold is fine three days out and absurd eight
      // minutes before kickoff — see `policy.holdWindowMs` in stubs.ts). And whatever that
      // works out to, the hold can never outlive the moment sales stop, so we take whichever
      // comes first.
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
   * Look up a session and bring it up to date before handing it back.
   *
   * This is the function behind "resume". Both surfaces call it through
   * src/lib/page-data.ts, and GET /api/sessions/:id calls it directly. There is no separate
   * "resume" concept anywhere in this codebase — resuming is just reading.
   *
   * Reading is also when a session catches up with reality, because three things can go
   * stale while nobody is looking:
   *
   *   1. The hold's deadline passed. The session is expired and the seats go back.
   *   2. The seller pulled the listing. The session failed and the seats go back.
   *   3. A payment was in flight. We ask the provider how it went and record the answer.
   *
   * Only the third needs to leave the building, which is why this function is async while
   * the first two branches finish without ever pausing.
   */
  async function get(id: string, seenOn?: CreateInput["surface"]): Promise<Session> {
    let s = db.get(id) ?? fail("NOT_FOUND");
    const now = deps.clock.now();

    // Note that only ACTIVE sessions can expire. A session waiting on a payment is
    // deliberately immune to the clock: if the deadline could fire mid-charge we would hand
    // the seats to somebody else while the first fan's card was being charged, and sell the
    // same seats twice. A payment in flight ends when the provider says so, never when the
    // timer says so.
    if (s.status === "ACTIVE" && now >= s.holdExpiresAt) s = release(s, { status: "EXPIRED" });
    else if (s.status === "ACTIVE" && !deps.inventory.backs(s.listingId))
      s = release(s, { status: "FAILED", failReason: "INVENTORY_WITHDRAWN" });
    // The `await` below is the only pause in this function. Everything `s` holds is stale
    // from here on, which is exactly why `settle` re-reads instead of trusting what we pass.
    else if (s.status === "PAYMENT_PENDING") s = settle(s.id, await deps.payments.status(s.paymentIntentId));

    if (seenOn && seenOn !== s.lastSeenOn) {
      deps.events.emit("session_resumed", { sessionId: s.id, surface: seenOn, fromSurface: s.lastSeenOn, ageMs: now - s.createdAt });
      // Written straight to the map instead of through `put`, which is the one deliberate
      // exception in this file. `put` would bump `version`, and `version` is what tells a
      // device "something changed, your copy is out of date". Nothing changed. If merely
      // glancing at the checkout on your phone bumped the version, the laptop's Pay button
      // would start failing for no reason the fan could possibly understand. This field is
      // for our analytics, not for them.
      s = { ...s, lastSeenOn: seenOn };
      db.set(s.id, s);
    }

    // Nudge the fan before their hold runs out.
    //
    // Continuity only works if something brings people back — a push notification, an email,
    // a "you left something" banner. In a real system a scheduler fires this at a set time.
    // Here the clock is a stub that tests fast-forward at will, so there is no scheduler to
    // hook into and the next read is the honest substitute. The `notified` set above keeps it
    // to one notice per session no matter how many times the page is refreshed.
    //
    // The notifier itself is in stubs.ts and just writes to the event log; the deep link it
    // would carry is the one src/app/deeplink/[id]/route.ts serves.
    if (s.status === "ACTIVE" && now >= s.holdExpiresAt - deps.policy.notifyLeadMs && !notified.has(s.id)) {
      notified.add(s.id);
      deps.notifier.holdExpiringSoon(s.id);
    }
    return s;
  }

  /**
   * Read the session as it is at this instant, with no updating and no pausing.
   *
   * `get` above is async, so any function that called it has already stepped aside once and
   * whatever it got back may be out of date. Every function that intends to *change* a
   * session calls this immediately before doing so, and then does its checking and its
   * writing without a single `await` in between. That unbroken stretch is what makes the
   * change safe — see the long note at the top of this file.
   */
  function current(id: string): Session {
    return db.get(id) ?? fail("NOT_FOUND");
  }

  /**
   * Has the listing's price moved since we quoted this fan?
   *
   * Returns the old total, the new total, and the version number of the new price, or
   * nothing at all if the quote is still current. The session itself is never updated
   * behind the fan's back — the promise this app makes is that the amount charged is always
   * an amount they were shown and agreed to, and `acceptPrice` below is the only way that
   * agreement gets recorded.
   *
   * Drawn as the "the price changed while you were away" panel in
   * src/app/_components/RecoveryState.tsx.
   */
  function priceChange(s: Session) {
    if (s.status !== "ACTIVE") return undefined;
    const live = deps.pricing.current(s.listingId);
    if (live.version === s.priceVersion) return undefined;
    return { from: s.quotedTotal, to: live.total * s.quantity, newPriceVersion: live.version };
  }

  /**
   * Record that the fan has seen the new price and agreed to it.
   *
   * Reached from the "Accept" button on the price-change panel. After this the session is
   * quoting the new total and `complete` will go through.
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
   * The session `complete` hands back when it is not rejecting.
   *
   * Only two states are an answer to the question the fan asked. COMPLETED means their money
   * moved; PAYMENT_PENDING means we are still finding out. Anything else ended for a reason
   * that has nothing to do with this press — most likely the pending timeout wrote the
   * session off while their charge was still in flight — and returning it normally would
   * hand back a 200 carrying a FAILED session. Every client that checks a status code before
   * reading a body would call that a success.
   *
   * So those go out as rejections, with the same code every other "this session cannot be
   * acted on" path uses. The screen is identical either way, because
   * src/app/_components/RecoveryState.tsx renders from status and both routes carry the
   * session — but the API stops contradicting itself about what a failure looks like.
   */
  function answer(s: Session): Session {
    if (s.status === "COMPLETED" || s.status === "PAYMENT_PENDING") return s;
    return fail(statusError(s), s, alternativesFor(s));
  }

  /**
   * Charge the card and turn the hold into an order. This is the hard one.
   *
   * Everything else in this file is bookkeeping we fully control. This function has to call
   * out to a payment provider, which means pausing, which means other requests get to run in
   * the middle of it. Almost every difficult question about this app is really a question
   * about the few lines below.
   *
   * There are two completely different ways a fan can end up asking to pay twice, and they
   * need two different answers. Mixing them up gives you either a double charge or a fan
   * stuck staring at an error.
   *
   *   TWO DEVICES, TWO SEPARATE ATTEMPTS.
   *   The laptop and the phone both have the checkout open and both press Pay. These are
   *   genuinely two different attempts by a confused person. One should go through and the
   *   other should be told "you're already paying on your other device". The status check
   *   below does this: whoever gets there first flips the session to PAYMENT_PENDING, and
   *   the second one finds it no longer ACTIVE.
   *
   *   ONE DEVICE, ONE ATTEMPT, SENT TWICE.
   *   The fan double-clicks, or the network drops the reply and the browser retries. This is
   *   one attempt that happens to have arrived twice, and the right answer is to pretend the
   *   second one never happened and hand back the result of the first. The idempotency key
   *   does this: the browser generates one value per rendered form (see
   *   src/lib/page-data.ts, which mints it, and src/app/_components/PayForm.tsx, which
   *   carries it in a hidden input), so both copies of the same attempt share a key.
   *
   * The status check cannot handle the second case — a retry would be told it is competing
   * with itself. The key cannot handle the first — two devices have different keys. Hence
   * both, each doing the job the other cannot.
   */
  async function complete(id: string, input: CompleteInput): Promise<Session> {
    // The key must be a real string, and a bounded one.
    //
    // It used to be enough for it to be truthy, and the route reached it through `String(...)`.
    // That combination had a sharp edge: `String({})` is `"[object Object]"`, so every caller
    // who sent a non-string key landed on the *same* key. Two genuinely different attempts
    // would collide, and the second would be handed the first one's order — the replay
    // mechanism firing on requests it was never meant to connect. Demonstrated and fixed.
    //
    // The length cap is because this string is stored on the session for as long as the
    // session lives, so an unbounded one is a memory leak with a 200 response.
    if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey || input.idempotencyKey.length > 200)
      fail("INVALID_REQUEST");

    // No default. A payment token is the one field where a fallback is actively dangerous:
    // the stub ignores it, so a missing token silently "worked", and the day this is wired to
    // a real provider that same path would attempt a charge against a placeholder.
    if (typeof input.paymentToken !== "string" || !input.paymentToken) fail("INVALID_REQUEST");
    await get(id, input.surface); // bring the session up to date; this may pause
    const s = current(id); // ---- from here to the `put` below: no pausing allowed ----

    // Have we seen this exact attempt before? If so, give back the same answer we gave last
    // time and do not go anywhere near the card. Because the key is recorded down below at
    // the same instant the session flips to PAYMENT_PENDING, this also catches the case
    // where the first copy of the attempt is still in flight — that gets "we're confirming
    // your payment", which is true and calm, rather than a confusing error.
    const replayed = s.idempotency[input.idempotencyKey];
    if (replayed !== undefined) {
      // Give the same answer as last time, including the same failure. Returning a cheerful
      // 200 for a retry of something that was declined would read as success.
      if (replayed === "declined") fail("PAYMENT_DECLINED", s);
      return answer(s);
    }

    // A different attempt entirely. Everything below rejects it by telling the truth about
    // the session, so whichever screen the fan is on can redraw itself correctly.
    if (s.status === "PAYMENT_PENDING") fail("IN_PROGRESS_ELSEWHERE", s);
    if (s.status !== "ACTIVE") fail(statusError(s), s, alternativesFor(s));
    // `version` is how we catch a screen that is out of date. Every response tells the
    // client the session's current version number, and every request has to send back the
    // number it was looking at. If they differ, something changed since that screen was
    // drawn — maybe the other device accepted a price change — so this press was made
    // against information the fan can no longer see. We refuse and hand back the current
    // session so their screen can catch up.
    if (input.version !== s.version) fail("STALE_VERSION", s);

    // The price gets checked twice, and both checks are necessary.
    //
    //   Did this device see the price the session is holding?  (input vs session)
    //   Is the price the session is holding still the real one? (session vs listing)
    //
    // The first alone leaves a gap: the fan loads the page, the seller changes the price,
    // the fan presses Pay. Their version number and the session's still agree — nothing
    // about the session changed — but the quote is stale. The second check closes it.
    const live = deps.pricing.current(s.listingId);
    if (input.priceVersion !== s.priceVersion || s.priceVersion !== live.version)
      fail("PRICE_CHANGED", s, { priceChange: priceChange(s) ?? { from: s.quotedTotal, to: s.quotedTotal, newPriceVersion: s.priceVersion } });

    // ---- This write is the moment that decides who gets to pay. ----
    //
    // Everything from `current(id)` down to here ran without a single pause, so no other
    // request could have touched the session in between. That means the checks above were
    // still true at the instant this write lands. Flipping the status to PAYMENT_PENDING
    // now closes the door: any other attempt that arrives from here on finds a session that
    // is no longer ACTIVE and gets turned away.
    const pending = put({
      ...strip(s),
      status: "PAYMENT_PENDING",

      // The payment gets an ID before the charge is attempted, and we reuse the session's
      // own ID for it. Two things follow from that.
      //
      // First, it is recorded, so if this server dies one line from now the fan's card may
      // have been charged but nobody wrote it down — and the next read of this session can
      // ask the provider "what happened to payment cs_0001?" and find out. That recovery is
      // in `get` above.
      //
      // Second, because it is derived from the session rather than generated fresh, asking
      // the provider to charge it twice cannot produce two charges. Providers treat a
      // repeated ID as a repeat of the same request.
      paymentIntentId: s.id,
      pendingSince: deps.clock.now(),

      // Claim the idempotency key here, in the same write, rather than after the charge
      // comes back. If we waited, a double-click would arrive while the first copy was
      // still talking to the provider, find no key recorded yet, and be told it was
      // competing with another device — about itself.
      //
      // "unknown" is a placeholder meaning "this attempt is underway and we don't yet know
      // how it went", which is exactly what a second copy of it should be told. The real
      // outcome overwrites it below.
      idempotency: { ...s.idempotency, [input.idempotencyKey]: "unknown" },
    }) as SessionOf<"PAYMENT_PENDING">;
    deps.events.emit("payment_started", { sessionId: s.id, surface: input.surface });

    // The pause. Other requests run during this, which is the entire reason for the care
    // taken above. The seats are safe: the session is no longer ACTIVE, so the clock can no
    // longer expire it out from under the charge.
    const outcome = await deps.payments
      .charge(pending.paymentIntentId, input.paymentToken)
      // The call itself blew up — the connection dropped, the provider timed out. It is
      // tempting to treat that as a failure, and it is the single most expensive mistake
      // available here, because we genuinely do not know whether the charge went through. A
      // fan told "that didn't work, try again" types their card in a second time and gets
      // billed twice. So a dead connection is "unknown", the seats stay held, the fan is
      // told we are still confirming, and the next read of the session asks the provider
      // what actually happened.
      .catch((): PaymentOutcome => "unknown");

    // Write down how it went. `settle` re-reads the session first, because that `await`
    // means somebody else may have resolved this payment while we waited.
    const settled = settle(id, outcome);

    // Record the outcome against this attempt's key, so a retry gets this same answer back
    // instead of starting a second charge.
    const withReplay = put({ ...settled, idempotency: { ...settled.idempotency, [input.idempotencyKey]: outcome } });

    // A declined card is a failure the fan can act on: it is safe to try another card,
    // because we know for certain no money moved. That is what separates it from "unknown",
    // which `answer` lets through with the session still pending.
    if (outcome === "declined") fail("PAYMENT_DECLINED", withReplay);
    return answer(withReplay);
  }

  /**
   * Try again after a hold ran out.
   *
   * This does not revive the old session — an expired session is finished for good. It
   * starts a brand new one for the same seats and records a pointer from the old to the new.
   * That pointer is what lets a stale link or an old notification still lead somewhere
   * useful instead of a dead end.
   *
   * Calling it twice returns the same new session rather than holding a second set of seats,
   * which matters because "Try again" is a button a frustrated person presses repeatedly.
   */
  function rehold(id: string): Session {
    const old = db.get(id) ?? fail("NOT_FOUND");
    if (old.status !== "EXPIRED") return fail(statusError(old), old, alternativesFor(old));
    if (old.successorSessionId) return db.get(old.successorSessionId)!;
    const next = create({ listingId: old.listingId, quantity: old.quantity, surface: old.lastSeenOn });
    put({ ...old, successorSessionId: next.id });
    return next;
  }

  /**
   * Pick the error code that best explains why a session cannot be acted on right now.
   *
   * The code is not for the fan; it decides which wording and which button the screen shows.
   * The screen itself is drawn from the session that travels alongside it. See the switch in
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
     * Used by the home page (src/app/page.tsx) to show a "you have a hold in progress"
     * banner with its countdown. A notification is one way back into an abandoned checkout;
     * seeing it waiting for you when you next open the site is another, and it needs no
     * infrastructure at all. This only reads — it never changes anything.
     */
    resumable: () => {
      const now = deps.clock.now();
      return [...db.values()]
        .filter((s) => s.status === "ACTIVE" && now < s.holdExpiresAt)
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    // Used by the tests and by GET /api/debug/state. Named with a leading underscore
    // because nothing in the real application should be calling them.
    /** Test and debug only. */
    _all: () => [...db.values()],
    _reset: () => { db.clear(); notified.clear(); },
    _isTerminal: (s: Session) => TERMINAL.has(s.status),
  };
}

export type Checkout = ReturnType<typeof createCheckout>;

import { describe, expect, it } from "vitest";
import { MIN, T0, completeBody, fresh, rejects } from "./helpers";

// Each test here is one row from the scenario table in the README. They run against the domain
// directly rather than through HTTP or the UI, because those layers are thin adapters over exactly
// these same calls, so testing the domain is where the rules themselves are actually pinned down.

describe("cross-surface resume", () => {
  it("1. create on web → resume on mobile → complete on mobile", async () => {
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 2, surface: "web" });
    expect(s.status).toBe("ACTIVE");
    expect(stubs.inventory.get("L1").available).toBe(2);

    const resumed = await checkout.get(s.id, "mobile");
    expect(resumed.id).toBe(s.id);
    expect(resumed.lastSeenOn).toBe("mobile");

    const done = await checkout.complete(s.id, completeBody(resumed, "k1", "mobile"));
    expect(done.status).toBe("COMPLETED");
    if (done.status === "COMPLETED") expect(done.orderId).toMatch(/^ord_/);

    const names = stubs.events.all().map((e) => e.name);
    expect(names).toEqual(["session_created", "session_resumed", "payment_started", "completed"]);
    expect(stubs.events.all().find((e) => e.name === "session_resumed")).toMatchObject({ surface: "mobile", fromSurface: "web" });
  });

  it("12. resuming a terminal session renders it, never re-reserves", async () => {
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L3", quantity: 1, surface: "web" });
    await checkout.complete(s.id, completeBody(s));
    const again = await checkout.get(s.id, "mobile");
    expect(again.status).toBe("COMPLETED");
    expect(stubs.inventory.get("L3").available).toBe(0);
  });

  it("13. unknown session id → NOT_FOUND", async () => {
    const { checkout } = fresh();
    expect((await rejects(checkout.get("nope"))).code).toBe("NOT_FOUND");
  });
});

describe("price change", () => {
  it("2. price rises while away → complete refused until accepted", async () => {
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    stubs.pricing.setTotal("L1", 9900);

    const resumed = await checkout.get(s.id, "mobile");
    expect(checkout.priceChange(resumed)).toEqual({ from: 8900, to: 9900, newPriceVersion: 2 });

    const err = await rejects(checkout.complete(s.id, completeBody(resumed)));
    expect(err.code).toBe("PRICE_CHANGED");
    expect(err.extra.priceChange).toEqual({ from: 8900, to: 9900, newPriceVersion: 2 });

    const accepted = await checkout.acceptPrice(s.id, { version: resumed.version, priceVersion: 2 });
    expect(accepted.quotedTotal).toBe(9900);
    const done = await checkout.complete(s.id, completeBody(accepted));
    expect(done.status).toBe("COMPLETED");
  });

  it("price changes between the client's GET and its complete → still refused", async () => {
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    const body = completeBody(s); // client saw priceVersion 1
    stubs.pricing.setTotal("L1", 5000); // ...then the price moved
    expect((await rejects(checkout.complete(s.id, body))).code).toBe("PRICE_CHANGED");
  });

  it("acceptPrice with a stale priceVersion is refused", async () => {
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    stubs.pricing.setTotal("L1", 9900);
    stubs.pricing.setTotal("L1", 9950);
    expect((await rejects(checkout.acceptPrice(s.id, { version: s.version, priceVersion: 2 }))).code).toBe("PRICE_CHANGED");
  });
});

describe("expiry", () => {
  it("3. hold expires while away → EXPIRED on resume, seats released, re-hold creates a successor", async () => {
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    stubs.clock.advance(11 * MIN);

    const resumed = await checkout.get(s.id, "mobile");
    expect(resumed.status).toBe("EXPIRED");
    expect(stubs.inventory.get("L1").available).toBe(4);

    const next = await checkout.rehold(s.id);
    expect(next.id).not.toBe(s.id);
    expect(next.status).toBe("ACTIVE");
    const old = await checkout.get(s.id);
    expect(old.status === "EXPIRED" && old.successorSessionId).toBe(next.id);
    expect((await checkout.rehold(s.id)).id).toBe(next.id); // idempotent
  });

  it("8. timer hits zero mid-payment → payment finishes, seat not released", async () => {
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L3", quantity: 1, surface: "web" });
    stubs.payments.delayMs = 5;
    const p = checkout.complete(s.id, completeBody(s));
    stubs.clock.advance(20 * MIN); // deadline passes while the card is being charged
    const done = await p;
    expect(done.status).toBe("COMPLETED");
    expect(stubs.inventory.get("L3").available).toBe(0);
  });

  it("11. hold created near event start is capped at the sales cutoff", async () => {
    const { checkout, stubs } = fresh();
    // L2 starts in 25 min, cutoff 5 min before → 20 min of selling left; window inside last hour = 5 min
    const s = await checkout.create({ listingId: "L2", quantity: 1, surface: "web" });
    expect(s.holdExpiresAt).toBe(T0 + 5 * MIN);

    stubs.clock.advance(18 * MIN); // 2 min before cutoff
    const late = await checkout.create({ listingId: "L2", quantity: 1, surface: "web" });
    expect(late.holdExpiresAt).toBe(stubs.inventory.salesCutoff("L2")); // 2 min window would exceed cutoff
  });

  it("the fan gets a way back: one 'hold expiring soon' notice carrying the deep link", async () => {
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" }); // 10-min hold
    await checkout.get(s.id, "web");
    expect(stubs.events.all().filter((e) => e.name === "hold_expiring_notified")).toHaveLength(0);

    stubs.clock.advance(8 * MIN + 1); // inside the 2-minute lead
    await checkout.get(s.id, "mobile");
    await checkout.get(s.id, "web"); // repeated reads must not re-notify
    const notices = stubs.events.all().filter((e) => e.name === "hold_expiring_notified");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ sessionId: s.id, deepLink: `/deeplink/${s.id}` });
  });

  it("complete after expiry → EXPIRED error, hold released", async () => {
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    stubs.clock.advance(11 * MIN);
    const err = await rejects(checkout.complete(s.id, completeBody(s)));
    expect(err.code).toBe("EXPIRED");
    expect(stubs.inventory.get("L1").available).toBe(4);
  });
});

describe("payment outcomes", () => {
  it("5. declined → FAILED/DECLINED, hold released", async () => {
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    stubs.payments.nextResult = "declined";
    const err = await rejects(checkout.complete(s.id, completeBody(s)));
    expect(err.code).toBe("PAYMENT_DECLINED");
    expect(err.session?.status).toBe("FAILED");
    expect(stubs.inventory.get("L1").available).toBe(4);
  });

  it("6. same device retries with the same idempotency key → same outcome, one charge", async () => {
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    const first = await checkout.complete(s.id, completeBody(s, "k-retry"));
    const second = await checkout.complete(s.id, completeBody(s, "k-retry"));
    expect(second.status).toBe("COMPLETED");
    if (first.status !== "COMPLETED" || second.status !== "COMPLETED") throw new Error("unreachable");
    expect(second.orderId).toBe(first.orderId);
    expect(stubs.events.all().filter((e) => e.name === "completed")).toHaveLength(1);
  });

  it("a replayed decline gets the same answer, not a silent 200", async () => {
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    stubs.payments.nextResult = "declined";
    expect((await rejects(checkout.complete(s.id, completeBody(s, "k")))).code).toBe("PAYMENT_DECLINED");
    // Same key, same attempt, same answer — a retry must not look like it succeeded.
    const replay = await rejects(checkout.complete(s.id, completeBody(s, "k")));
    expect(replay.code).toBe("PAYMENT_DECLINED");
    expect(replay.session?.status).toBe("FAILED");
    expect(stubs.events.all().filter((e) => e.name === "payment_started")).toHaveLength(1);
  });

  it("7. charge succeeded but the response was lost → PENDING, then GET reconciles to COMPLETED", async () => {
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    stubs.payments.nextResult = "lost"; // the provider charged; the response never arrived

    // Since a transport failure tells us nothing about whether the charge landed, it is treated as
    // `unknown` rather than a decline: the fan is left on "we're confirming" instead of an error page,
    // and the hold is not released on a charge that may well have gone through.
    const stuck = await checkout.complete(s.id, completeBody(s));
    expect(stuck.status).toBe("PAYMENT_PENDING");
    expect(stubs.inventory.get("L1").available).toBe(3);

    // Since a retry of the same form reconciles on its own read before replaying the answer, it gets
    // a 200 with the completed session rather than a 409 about a session the fan never knew had moved.
    const retried = await checkout.complete(s.id, completeBody(s));
    expect(retried.status).toBe("COMPLETED");

    const reconciled = await checkout.get(s.id, "mobile");
    expect(reconciled.status).toBe("COMPLETED");
    expect(stubs.events.all().filter((e) => e.name === "completed")).toHaveLength(1); // charged once
  });

  it("10. unknown outcome → stays PENDING; times out to FAILED/PENDING_TIMEOUT", async () => {
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    stubs.payments.nextResult = "unknown";
    const pending = await checkout.complete(s.id, completeBody(s));
    expect(pending.status).toBe("PAYMENT_PENDING");

    // Another device: sees "in progress elsewhere", not "try again".
    expect((await rejects(checkout.complete(s.id, completeBody(pending, "other-device")))).code).toBe("IN_PROGRESS_ELSEWHERE");

    stubs.clock.advance(3 * MIN);
    const failed = await checkout.get(s.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.status === "FAILED" && failed.failReason).toBe("PENDING_TIMEOUT");
    expect(stubs.inventory.get("L1").available).toBe(4);
  });

  it("unknown outcome that the provider later confirms → COMPLETED on next read", async () => {
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    stubs.payments.nextResult = "unknown";
    await checkout.complete(s.id, completeBody(s));
    stubs.payments.setStatus(s.id, "ok");
    expect((await checkout.get(s.id)).status).toBe("COMPLETED");
  });
});

describe("inventory", () => {
  it("9. listing withdrawn while ACTIVE and unexpired → FAILED/INVENTORY_WITHDRAWN", async () => {
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    stubs.inventory.withdraw("L1");
    const resumed = await checkout.get(s.id, "mobile");
    expect(resumed.status).toBe("FAILED");
    expect(resumed.status === "FAILED" && resumed.failReason).toBe("INVENTORY_WITHDRAWN");
    expect((await rejects(checkout.complete(s.id, completeBody(s)))).code).toBe("INVENTORY_WITHDRAWN");
  });

  it("a hold nobody re-read still frees its seats for the next fan", async () => {
    const { checkout, stubs } = fresh();
    const abandoned = await checkout.create({ listingId: "L3", quantity: 1, surface: "web" }); // L3 has 1 seat
    stubs.clock.advance(11 * MIN); // the fan closed the tab; nothing ever reads this session

    // Expiry is a predicate, but the inventory counter has to be told. `create` evaluates it
    // for the listing first, so the next fan is not blocked by a hold that lapsed long ago.
    const next = await checkout.create({ listingId: "L3", quantity: 1, surface: "mobile" });
    expect(next.status).toBe("ACTIVE");
    expect((await checkout.get(abandoned.id)).status).toBe("EXPIRED");
    expect(stubs.events.all().filter((e) => e.name === "hold_expired")).toHaveLength(1);
  });

  it("a malformed quantity is rejected, not coerced into the inventory counter", async () => {
    const { checkout, stubs } = fresh();
    for (const quantity of [NaN, 0, -1, 1.5]) {
      expect((await rejects(checkout.create({ listingId: "L1", quantity, surface: "web" }))).code)
        .toBe("INVALID_REQUEST");
    }
    expect(stubs.inventory.get("L1").available).toBe(4); // untouched
  });

  it("a withdrawn listing hands back comparable listings, never a dead end", async () => {
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    stubs.inventory.withdraw("L1");
    const failed = await checkout.get(s.id, "mobile");

    const err = await rejects(checkout.complete(s.id, completeBody(s)));
    expect(err.code).toBe("INVENTORY_WITHDRAWN");
    expect(err.extra.alternatives).toEqual(checkout.alternativesFor(failed)?.alternatives);
    expect((err.extra.alternatives as { id: string }[]).map((a) => a.id)).toEqual(["L2", "L3"]);
  });

  it("checkout refuses to open once sales have closed", async () => {
    const { checkout, stubs } = fresh();
    const cutoff = stubs.inventory.salesCutoff("L2");

    // One minute before the cutoff a hold is still possible — and capped at the cutoff.
    stubs.clock.advance(19 * MIN);
    const last = await checkout.create({ listingId: "L2", quantity: 1, surface: "web" });
    expect(last.holdExpiresAt).toBe(cutoff);
    expect(last.holdExpiresAt).toBeGreaterThan(stubs.clock.now());

    // One minute after it, `min(now + window, cutoff)` would hand back a deadline in the
    // past: an ACTIVE session the next read immediately expires. Refuse instead.
    stubs.clock.advance(2 * MIN);
    expect((await rejects(checkout.create({ listingId: "L2", quantity: 1, surface: "web" }))).code)
      .toBe("SALES_CLOSED");

    // Both seats are free: the sweep at the top of `create` returned the lapsed one, and the
    // refusal itself took none — the cutoff is checked before any inventory is held.
    expect(stubs.inventory.get("L2").available).toBe(2);
  });

  it("sold out → SOLD_OUT on create", async () => {
    const { checkout } = fresh();
    await checkout.create({ listingId: "L3", quantity: 1, surface: "web" });
    expect((await rejects(checkout.create({ listingId: "L3", quantity: 1, surface: "web" }))).code).toBe("SOLD_OUT");
  });
});

describe("abandoned pending payments (reviewer P1-1, P1-2)", () => {
  it("a pending payment nobody re-reads still frees its seats for the next fan", async () => {
    // P1-1. This reserves the only seat on L3, gets no answer from the provider, and walks away.
    // Since the fix, the seat comes back for the next fan; before it, the seat stayed held forever,
    // because only ACTIVE sessions were swept and the pending timeout only fired when someone read
    // that particular session — which nobody does after closing the tab.
    const { checkout, stubs } = fresh();
    const abandoned = await checkout.create({ listingId: "L3", quantity: 1, surface: "web" });
    stubs.payments.nextResult = "unknown";
    await checkout.complete(abandoned.id, completeBody(abandoned));
    expect(stubs.inventory.get("L3").available).toBe(0);

    stubs.clock.advance(11 * MIN); // long past the 2-minute pending timeout; nobody reads it

    // The next fan's create sweeps the listing, which now also reconciles the timed-out
    // pending hold: it asks the provider (still "unknown"), times it out, and frees the seat.
    const next = await checkout.create({ listingId: "L3", quantity: 1, surface: "mobile" });
    expect(next.status).toBe("ACTIVE");
    expect((await checkout.get(abandoned.id)).status).toBe("FAILED");
    expect(stubs.events.all().filter((e) => e.name === "session_failed")).toHaveLength(1);
  });

  it("a charge that lands after the timeout already failed the session is still refunded", async () => {
    // P1-2. The sequence is: unknown outcome, then the timeout fails the session and releases the
    // seat, then the provider confirms the charge actually went through. Since the fix, a later read
    // re-checks and refunds; before it, no read ever consulted the provider again, so the fan was
    // charged with nobody the wiser — zero reconcile_conflict events.
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    stubs.payments.nextResult = "unknown";
    await checkout.complete(s.id, completeBody(s));

    stubs.clock.advance(3 * MIN);
    const failed = await checkout.get(s.id);
    expect(failed.status === "FAILED" && failed.failReason).toBe("PENDING_TIMEOUT");
    expect(stubs.inventory.get("L1").available).toBe(4);

    stubs.payments.setStatus(s.id, "ok"); // the provider finally makes up its mind: charged

    const reconciled = await checkout.get(s.id, "mobile");
    expect(reconciled.status).toBe("FAILED"); // stays failed — the seat is already sold on
    expect(stubs.events.all().filter((e) => e.name === "reconcile_conflict")).toHaveLength(1);
    expect(stubs.events.all().filter((e) => e.name === "refund_issued")).toHaveLength(1);
    expect(stubs.payments.refunded()).toEqual([s.id]);

    // Idempotent: reading it again does not refund twice.
    await checkout.get(s.id);
    await checkout.get(s.id, "web");
    expect(stubs.payments.refunded()).toEqual([s.id]);
  });

  it("a late-confirmed charge discovered during a sweep is refunded too", async () => {
    // The same reconciliation, but reached through the independent trigger (a sweep) rather than a
    // direct read of the session — which is what makes it work even if the abandoning fan never
    // comes back.
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    stubs.payments.nextResult = "unknown";
    await checkout.complete(s.id, completeBody(s));
    stubs.clock.advance(3 * MIN);
    await checkout.get(s.id); // times out → FAILED/PENDING_TIMEOUT, still carrying its intent
    stubs.payments.setStatus(s.id, "ok");

    await checkout.sweepExpired(); // a different fan loading a page triggers this
    expect(stubs.events.all().filter((e) => e.name === "refund_issued")).toHaveLength(1);
    expect(stubs.payments.refunded()).toEqual([s.id]);
  });

  it("a pending charge that turns out declined releases the seat on the next sweep", async () => {
    // The seat-freeing path for when the abandoned charge turns out to have been declined, in which
    // case no money moved and no refund is owed.
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L3", quantity: 1, surface: "web" });
    stubs.payments.nextResult = "unknown";
    await checkout.complete(s.id, completeBody(s));
    stubs.clock.advance(11 * MIN);
    stubs.payments.setStatus(s.id, "declined"); // provider: that card was refused

    const next = await checkout.create({ listingId: "L3", quantity: 1, surface: "web" });
    expect(next.status).toBe("ACTIVE");
    const failed = await checkout.get(s.id);
    expect(failed.status === "FAILED" && failed.failReason).toBe("DECLINED");
    expect(stubs.payments.refunded()).toEqual([]); // nothing to refund
  });
});

describe("per-client hold dedup (one browser can't drain a listing via repeated sessions)", () => {
  it("repeating create for the same browser and listing resumes the one hold instead of taking more seats", async () => {
    // The reported bug: Buy → Start → Back → repeat lets one browser reserve L1's whole inventory
    // through separate sessions. With a client identity, every repeat returns the same session.
    const { checkout, stubs } = fresh();
    const cid = "browser-A";
    const first = await checkout.create({ listingId: "L1", quantity: 1, surface: "web", clientId: cid });
    expect(stubs.inventory.get("L1").available).toBe(3); // one seat held, three left

    for (let i = 0; i < 5; i++) {
      const again = await checkout.create({ listingId: "L1", quantity: 1, surface: "web", clientId: cid });
      expect(again.id).toBe(first.id); // same session, every time
    }
    expect(stubs.inventory.get("L1").available).toBe(3); // still three — no extra seats taken
    expect(checkout._all().filter((s) => s.status === "ACTIVE")).toHaveLength(1);
    expect(stubs.events.all().filter((e) => e.name === "hold_resumed_same_client")).toHaveLength(5);
  });

  it("a different browser still gets its own hold", async () => {
    const { checkout, stubs } = fresh();
    const a = await checkout.create({ listingId: "L1", quantity: 1, surface: "web", clientId: "browser-A" });
    const b = await checkout.create({ listingId: "L1", quantity: 1, surface: "web", clientId: "browser-B" });
    expect(b.id).not.toBe(a.id);
    expect(stubs.inventory.get("L1").available).toBe(2); // two distinct holds
  });

  it("the same browser may hold different listings at once", async () => {
    const { checkout } = fresh();
    const cid = "browser-A";
    const l1 = await checkout.create({ listingId: "L1", quantity: 1, surface: "web", clientId: cid });
    const l2 = await checkout.create({ listingId: "L2", quantity: 1, surface: "web", clientId: cid });
    expect(l2.id).not.toBe(l1.id); // dedup is per listing, so a real multi-event purchase still works
  });

  it("once the browser's hold has expired, a repeat starts a fresh one", async () => {
    const { checkout, stubs } = fresh();
    const cid = "browser-A";
    const first = await checkout.create({ listingId: "L1", quantity: 1, surface: "web", clientId: cid });
    stubs.clock.advance(11 * MIN); // the hold lapses

    const second = await checkout.create({ listingId: "L1", quantity: 1, surface: "web", clientId: cid });
    expect(second.id).not.toBe(first.id); // a dead hold is not resumed
    expect(second.status).toBe("ACTIVE");
    expect((await checkout.get(first.id)).status).toBe("EXPIRED");
  });

  it("a mid-payment browser is returned to its pending hold, not sent to a second one", async () => {
    const { checkout, stubs } = fresh();
    const cid = "browser-A";
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web", clientId: cid });
    stubs.payments.nextResult = "unknown";
    await checkout.complete(s.id, completeBody(s)); // now PAYMENT_PENDING

    const again = await checkout.create({ listingId: "L1", quantity: 1, surface: "web", clientId: cid });
    expect(again.id).toBe(s.id);
    expect(again.status).toBe("PAYMENT_PENDING");
    expect(stubs.inventory.get("L1").available).toBe(3); // still just the one held seat
  });

  it("without a clientId, each create is independent — the old, un-deduped behaviour", async () => {
    const { checkout, stubs } = fresh();
    await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    expect(stubs.inventory.get("L1").available).toBe(2); // two separate holds, no dedup
  });
});

describe("versions", () => {
  it("14. device clock is irrelevant: the server never reads client time", async () => {
    // Since the server owns the clock, there is no client-time input anywhere in the API, and this
    // test documents that by completing with a body that carries no timestamp at all.
    const { checkout } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    const body = completeBody(s);
    expect(Object.keys(body).sort()).toEqual(["idempotencyKey", "paymentToken", "priceVersion", "surface", "version"]);
    expect((await checkout.complete(s.id, body)).status).toBe("COMPLETED");
  });

  it("15. client version ahead of the server's → STALE_VERSION", async () => {
    const { checkout } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    const err = await rejects(checkout.complete(s.id, { ...completeBody(s), version: s.version + 5 }));
    expect(err.code).toBe("STALE_VERSION");
    expect(err.session?.version).toBe(s.version);
  });

  it("client version behind the server's (other device accepted a price) → STALE_VERSION", async () => {
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    stubs.pricing.setTotal("L1", 9900);
    await checkout.acceptPrice(s.id, { version: s.version, priceVersion: 2, surface: "mobile" });
    // The web tab still holds the pre-accept version. Since `priceVersion` alone would also catch
    // this, the point is that `version` is the generic "you haven't seen the latest" guard and fires
    // first.
    expect((await rejects(checkout.complete(s.id, completeBody(s)))).code).toBe("STALE_VERSION");
  });

  it("a read from another surface does not invalidate this device's version", async () => {
    const { checkout } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    await checkout.get(s.id, "mobile"); // telemetry only
    expect((await checkout.complete(s.id, completeBody(s))).status).toBe("COMPLETED");
  });
});

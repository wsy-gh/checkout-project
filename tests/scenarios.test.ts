import { describe, expect, it } from "vitest";
import { MIN, T0, completeBody, fresh, rejects } from "./helpers";

// Each test is one row from the scenario table in the README. They run against the
// domain directly; the HTTP and UI layers are thin adapters over these same calls.

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

    const next = checkout.rehold(s.id);
    expect(next.id).not.toBe(s.id);
    expect(next.status).toBe("ACTIVE");
    const old = await checkout.get(s.id);
    expect(old.status === "EXPIRED" && old.successorSessionId).toBe(next.id);
    expect(checkout.rehold(s.id).id).toBe(next.id); // idempotent
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
    expect(second.status === "COMPLETED" && first.status === "COMPLETED" && second.orderId).toBe(first.orderId);
    expect(stubs.events.all().filter((e) => e.name === "completed")).toHaveLength(1);
  });

  it("7. charge succeeded but the response was lost → GET reconciles to COMPLETED", async () => {
    const { checkout, stubs } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    stubs.payments.nextResult = "lost";
    await expect(checkout.complete(s.id, completeBody(s))).rejects.toThrow("network");

    // The server "crashed" mid-flight. The session is PENDING with an intent recorded.
    const stuck = checkout._all()[0];
    expect(stuck.status).toBe("PAYMENT_PENDING");

    const reconciled = await checkout.get(s.id, "mobile");
    expect(reconciled.status).toBe("COMPLETED");
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

  it("sold out → SOLD_OUT on create", async () => {
    const { checkout } = fresh();
    await checkout.create({ listingId: "L3", quantity: 1, surface: "web" });
    expect((await rejects(Promise.resolve().then(() => checkout.create({ listingId: "L3", quantity: 1, surface: "web" })))).code).toBe("SOLD_OUT");
  });
});

describe("versions", () => {
  it("14. device clock is irrelevant: the server never reads client time", async () => {
    // There is no client-time input anywhere in the API. This test documents that by
    // completing with a body that carries no timestamp at all.
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
    // The web tab still holds the pre-accept version; priceVersion alone would also catch it,
    // but version is the generic "you haven't seen the latest" guard and fires first.
    expect((await rejects(checkout.complete(s.id, completeBody(s)))).code).toBe("STALE_VERSION");
  });

  it("a read from another surface does not invalidate this device's version", async () => {
    const { checkout } = fresh();
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    await checkout.get(s.id, "mobile"); // telemetry only
    expect((await checkout.complete(s.id, completeBody(s))).status).toBe("COMPLETED");
  });
});

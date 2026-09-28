import { describe, expect, it } from "vitest";
import { MIN, completeBody, fresh, rejects } from "./helpers";

// Two people (or one confused person with two devices) pressing Pay at the same time.
//
// Since the interference these tests are meant to catch can only happen when the two calls genuinely
// overlap in time, the fake payment provider pauses partway through, which hands control back to
// JavaScript and lets the second call run while the first is still waiting. That overlap is the whole
// point: a test that simply ran one call to completion and then the other would pass even against
// completely broken code, because the race would never occur. So if anyone ever adds an `await`
// between the checks and the status change in `complete`, these are the tests that notice.

describe("two devices complete at once", () => {
  it("exactly one order; the loser sees IN_PROGRESS_ELSEWHERE or the completed state", async () => {
    const { checkout, stubs } = fresh();
    stubs.payments.delayMs = 10;
    const s = await checkout.create({ listingId: "L3", quantity: 1, surface: "web" });
    const seen = await checkout.get(s.id, "mobile"); // both devices start from the same loaded version

    const [a, b] = await Promise.allSettled([
      checkout.complete(s.id, completeBody(seen, "device-A", "web")),
      checkout.complete(s.id, completeBody(seen, "device-B", "mobile")),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["fulfilled", "rejected"]);

    const loser = a.status === "rejected" ? a.reason : (b as PromiseRejectedResult).reason;
    expect(["IN_PROGRESS_ELSEWHERE", "ALREADY_COMPLETED"]).toContain(loser.code);

    const final = await checkout.get(s.id);
    expect(final.status).toBe("COMPLETED");
    expect(stubs.events.all().filter((e) => e.name === "completed")).toHaveLength(1);
    expect(stubs.inventory.get("L3").available).toBe(0);
  });

  it("holds under many concurrent attempts", async () => {
    const { checkout, stubs } = fresh();
    stubs.payments.delayMs = 3;
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) => checkout.complete(s.id, completeBody(s, `dev-${i}`))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(stubs.events.all().filter((e) => e.name === "completed")).toHaveLength(1);
  });

  it("a same-device double-submit of one form replays instead of racing", async () => {
    const { checkout, stubs } = fresh();
    stubs.payments.delayMs = 5;
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });

    // One rendered form submitted twice — a double-click with no JS to disable the button. Since both
    // copies carry the same key, this is the *same attempt*, and the fan must never be told that
    // another device is paying.
    const [a, b] = await Promise.all([
      checkout.complete(s.id, completeBody(s, "one-form")),
      checkout.complete(s.id, completeBody(s, "one-form")),
    ]);
    expect([a.status, b.status]).toContain("PAYMENT_PENDING"); // the replayed copy saw the attempt still in flight
    expect(stubs.events.all().filter((e) => e.name === "payment_started")).toHaveLength(1);
    expect((await checkout.get(s.id)).status).toBe("COMPLETED");
    expect(stubs.events.all().filter((e) => e.name === "completed")).toHaveLength(1);
  });
});

// The reconcile path is the other side of the same coin. Since `get` awaits the provider before
// writing, it needs the same re-read-after-await guard that `complete` has — and two surfaces
// refreshing a pending session at once is an ordinary thing to do, because the UI literally tells the
// fan to refresh. Before the guard, each of those reads settled the session independently, which is
// the bug these tests pin down.

describe("two surfaces reconcile a pending session at once", () => {
  it("releases the hold exactly once when the provider reports declined", async () => {
    const { checkout, stubs } = fresh();
    stubs.payments.nextResult = "unknown";
    const s = await checkout.create({ listingId: "L1", quantity: 2, surface: "web" });
    await checkout.complete(s.id, completeBody(s));
    expect(stubs.inventory.get("L1").available).toBe(2);

    stubs.payments.setStatus(s.id, "declined"); // the provider finally makes up its mind
    const reads = await Promise.all([checkout.get(s.id, "web"), checkout.get(s.id, "mobile"), checkout.get(s.id)]);

    expect(reads.every((r) => r.status === "FAILED")).toBe(true);
    // Without the guard this was 8: three concurrent reads each released onto a listing that only
    // ever had 4 seats.
    expect(stubs.inventory.get("L1").available).toBe(4);
    expect(stubs.events.all().filter((e) => e.name === "session_failed")).toHaveLength(1);
  });

  it("mints exactly one orderId when the provider reports success", async () => {
    const { checkout, stubs } = fresh();
    stubs.payments.nextResult = "unknown";
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    await checkout.complete(s.id, completeBody(s));

    stubs.payments.setStatus(s.id, "ok");
    const reads = await Promise.all([checkout.get(s.id, "web"), checkout.get(s.id, "mobile"), checkout.get(s.id)]);

    const orderIds = new Set(reads.map((r) => (r.status === "COMPLETED" ? r.orderId : null)));
    expect(orderIds.size).toBe(1);
    expect(stubs.events.all().filter((e) => e.name === "completed")).toHaveLength(1);
  });

  it("flags a charge that lands after the pending timeout already failed the session", async () => {
    const { checkout, stubs } = fresh();
    stubs.payments.delayMs = 20; // a slow provider
    const s = await checkout.create({ listingId: "L1", quantity: 1, surface: "web" });
    const paying = checkout.complete(s.id, completeBody(s));
    await new Promise((r) => setTimeout(r, 5)); // let the pay call get past the status flip and into the charge

    // While the card is being charged, the clock passes the pending timeout and the fan's other
    // device refreshes; that read fails the session and hands the seat back.
    stubs.clock.advance(3 * MIN);
    const read = await checkout.get(s.id, "mobile");
    expect(read.status === "FAILED" && read.failReason).toBe("PENDING_TIMEOUT");
    expect(stubs.inventory.get("L1").available).toBe(4);

    // ...and only then does the charge come back successful. Since the seat is already gone, the
    // session must NOT resurrect into COMPLETED over released inventory: it stays failed, the fan is
    // told a refund is coming, and the conflict is logged for the reconciliation job a real system
    // would run against the provider. The attempt is rejected rather than resolved because a 200
    // carrying a FAILED session would read as success to any client that checks the status code
    // first; the session travels with the rejection, so the screen is the same either way.
    const err = await rejects(paying);
    expect(err.code).toBe("ALREADY_FAILED");
    expect(err.session?.status).toBe("FAILED");
    expect(err.session?.status === "FAILED" && err.session.failReason).toBe("PENDING_TIMEOUT");
    expect(stubs.inventory.get("L1").available).toBe(4);
    expect(stubs.events.all().filter((e) => e.name === "reconcile_conflict")).toHaveLength(1);
    expect(stubs.events.all().filter((e) => e.name === "completed")).toHaveLength(0);
  });
});

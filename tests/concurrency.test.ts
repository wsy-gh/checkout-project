import { describe, expect, it } from "vitest";
import { completeBody, fresh } from "./helpers";

// Scenario 4. The payment stub yields to the event loop, so the two calls genuinely
// interleave. If someone ever puts an `await` between the guards and the status flip in
// `complete`, this test is what catches it.

describe("two devices complete at once", () => {
  it("exactly one order; the loser sees IN_PROGRESS_ELSEWHERE or the completed state", async () => {
    const { checkout, stubs } = fresh();
    stubs.payments.delayMs = 10;
    const s = await checkout.create({ listingId: "L3", quantity: 1, surface: "web" });
    const seen = await checkout.get(s.id, "mobile"); // both devices have loaded the same version

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
});

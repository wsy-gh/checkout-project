import { describe, expect, it } from "vitest";
import { assertInvariants } from "@/checkout/invariants";
import { isCheckoutError, type Session } from "@/checkout/types";
import { MIN, fresh } from "./helpers";

// Scenario 16, a property-style test. Since you cannot write ordinary assertions for a random
// sequence of operations — you do not know what should have happened — this instead throws random
// operations at the state machine and checks, after every single step, that every session still
// satisfies the invariants and the store-level rules, which hold no matter what happened. It uses no
// property-testing library, just a seeded RNG so any failure is reproducible from its seed.

function rng(seed: number) {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const OPS = ["create", "get", "accept", "complete", "advance", "withdraw", "restore", "reprice", "rehold"] as const;

describe("invariants under random operation sequences", () => {
  for (const seed of [1, 2, 3, 7, 42, 99, 1234, 31337]) {
    it(`seed ${seed}`, async () => {
      const rand = rng(seed);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
      const { checkout, stubs } = fresh();
      const ids: string[] = [];
      const listings = ["L1", "L2", "L3"];

      for (let step = 0; step < 120; step++) {
        const op = pick(OPS);
        const id = ids.length ? pick(ids) : undefined;
        try {
          switch (op) {
            case "create": {
              const s = await checkout.create({ listingId: pick(listings), quantity: 1, surface: pick(["web", "mobile"] as const) });
              ids.push(s.id);
              break;
            }
            case "get": if (id) await checkout.get(id, pick(["web", "mobile"] as const)); break;
            case "accept": {
              if (!id) break;
              const s = await checkout.get(id);
              await checkout.acceptPrice(id, { version: s.version, priceVersion: stubs.pricing.current(s.listingId).version });
              break;
            }
            case "complete": {
              if (!id) break;
              const s = await checkout.get(id);
              stubs.payments.nextResult = pick(["ok", "ok", "declined", "unknown"] as const);
              await checkout.complete(id, { version: s.version, priceVersion: s.priceVersion, idempotencyKey: `k${step}`, paymentToken: "t" });
              break;
            }
            case "advance": stubs.clock.advance(Math.floor(rand() * 4) * MIN); break;
            case "withdraw": stubs.inventory.withdraw(pick(listings)); break;
            case "restore": stubs.inventory.restore(pick(listings)); break;
            case "reprice": stubs.pricing.setTotal(pick(listings), 1000 + Math.floor(rand() * 9000)); break;
            case "rehold": if (id) { const s = await checkout.rehold(id); ids.push(s.id); } break;
          }
        } catch (e) {
          if (!isCheckoutError(e)) throw e; // an expected domain rejection is fine; anything else is a real bug
        }

        // Every session must satisfy the per-session invariants after every step.
        for (const s of checkout._all()) assertInvariants(s, stubs.clock.now(), stubs.inventory.salesCutoff(s.listingId));

        // ...and the whole store must satisfy the two rules no single-session check could express:
        // exactly one order id per session, and seats held plus seats available equal to the start count.
        const all = checkout._all();
        const orders = all.filter((s): s is Extract<Session, { status: "COMPLETED" }> => s.status === "COMPLETED").map((s) => s.orderId);
        expect(new Set(orders).size).toBe(orders.length);
        for (const l of listings) {
          const live = all.filter((s) => s.listingId === l && (s.status === "ACTIVE" || s.status === "PAYMENT_PENDING" || s.status === "COMPLETED"));
          const original = { L1: 4, L2: 2, L3: 1 }[l]!;
          expect(live.reduce((n, s) => n + s.quantity, 0) + stubs.inventory.get(l).available).toBe(original);
        }
      }
    });
  }
});

import { createCheckout } from "@/checkout/service";
import { makeStubs } from "@/checkout/stubs";
import { CheckoutError, type CompleteInput, type Session } from "@/checkout/types";

export const T0 = 1_700_000_000_000; // a fixed "now" so every test is deterministic
export const MIN = 60_000;

export function fresh() {
  const stubs = makeStubs({ now: T0 });
  const checkout = createCheckout(stubs);
  return { stubs, checkout };
}

export function completeBody(s: Session, key = "k1", surface: "web" | "mobile" = "web"): CompleteInput {
  return { version: s.version, priceVersion: s.priceVersion, idempotencyKey: key, paymentToken: "tok_test", surface };
}

/** Run an op and return the CheckoutError it threw, or fail the test if it didn't. */
export async function rejects(p: Promise<unknown>): Promise<CheckoutError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CheckoutError) return e;
    throw e;
  }
  throw new Error("expected a CheckoutError");
}

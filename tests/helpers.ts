import { createCheckout } from "@/checkout/service";
import { makeStubs } from "@/checkout/stubs";
import { isCheckoutError, type CheckoutError, type CompleteInput, type Session } from "@/checkout/types";

export const T0 = 1_700_000_000_000; // a fixed "now" the frozen clock starts from, so every test is deterministic
export const MIN = 60_000;

export function fresh() {
  const stubs = makeStubs({ now: T0 });
  const checkout = createCheckout(stubs);
  return { stubs, checkout };
}

export function completeBody(s: Session, key = "k1", surface: "web" | "mobile" = "web"): CompleteInput {
  return { version: s.version, priceVersion: s.priceVersion, idempotencyKey: key, paymentToken: "tok_test", surface };
}

/**
 * Runs an op expected to be rejected and returns the CheckoutError it threw, so tests can assert on
 * the code. Fails loudly if the op succeeded, or threw something that is not a CheckoutError — which
 * would be a real bug rather than an expected "no".
 */
export async function rejects(p: Promise<unknown>): Promise<CheckoutError> {
  try {
    await p;
  } catch (e) {
    if (isCheckoutError(e)) return e;
    throw e;
  }
  throw new Error("expected a CheckoutError");
}

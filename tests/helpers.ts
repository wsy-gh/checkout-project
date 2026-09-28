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
 * Run an async op that is expected to be rejected, and return the CheckoutError it threw.
 *
 * Since the tests assert on the *code* of an expected rejection, this needs to run the op, catch its
 * error, confirm it is one of our CheckoutErrors, and hand it back — failing the test loudly if the
 * op unexpectedly succeeded, or if it threw something that is not a CheckoutError (which would be a
 * real bug rather than an expected "no").
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

import { createCheckout, type Checkout } from "@/checkout/service";
import { makeStubs, type Stubs } from "@/checkout/stubs";

/**
 * One in-memory checkout for the whole process.
 *
 * Parked on globalThis so it survives dev-server module re-evaluation (HMR) and is the
 * same instance whether a Server Component, a Server Action, or a Route Handler reaches
 * it. In production you'd replace this file with a DB client; nothing else changes.
 */
const g = globalThis as unknown as { __checkout?: Checkout; __stubs?: Stubs };

export const stubs: Stubs = (g.__stubs ??= makeStubs());
export const checkout: Checkout = (g.__checkout ??= createCheckout(stubs));

/** Reset everything. Used by the demo script and tests that go through HTTP. */
export function resetAll() {
  g.__stubs = makeStubs();
  g.__checkout = createCheckout(g.__stubs);
}

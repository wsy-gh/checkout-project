import { createCheckout, type Checkout } from "@/checkout/service";
import { makeStubs, type Stubs } from "@/checkout/stubs";

/**
 * THE ONE RUNNING COPY OF THE APP'S STATE
 *
 * Everything server-side reaches the checkout through this file, so there is exactly one
 * store of sessions and one set of stubs for the whole process.
 *
 * It is attached to `globalThis`, which normally you would avoid. The reason is the dev
 * server: when you edit a file, Next.js re-runs the modules that changed. A plain
 * module-level `const` would be rebuilt by that, and you would lose every session mid-demo
 * on each save. Worse, pages, Server Actions and API routes are compiled into separate
 * module graphs, so they could each end up with their *own* store — a session created
 * through the API would come back "not found" from a page. Hanging it off the global keeps
 * one instance for everybody.
 *
 * In production this file is where a database client would go instead. Nothing else in
 * src/checkout/ would change, because the service never assumes its storage is a Map.
 */
const g = globalThis as unknown as { __checkout?: Checkout; __stubs?: Stubs };

export const stubs: Stubs = (g.__stubs ??= makeStubs());
export const checkout: Checkout = (g.__checkout ??= createCheckout(stubs));

/**
 * Wipe everything back to a fresh start. Used by POST /api/debug/reset and at the top of
 * scripts/demo.sh.
 *
 * Note that it empties the existing objects rather than assigning new ones. Any module that
 * already imported `checkout` is holding a reference to the old object, and reassigning here
 * would leave those modules pointing at an abandoned store while everything else used the
 * new one. Emptying in place means every holder sees the reset.
 */
export function resetAll() {
  stubs.reset();
  checkout._reset();
}

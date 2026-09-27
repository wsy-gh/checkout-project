import cluster from "node:cluster";
import { createCheckout, type Checkout } from "@/checkout/service";
import { makeStubs, type Stubs } from "@/checkout/stubs";
import { createRateLimiter, type RateLimiter } from "@/lib/rate-limit";
import { uuidv7 } from "@/lib/uuid";

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
const g = globalThis as unknown as {
  __checkout?: Checkout;
  __stubs?: Stubs;
  __limiter?: RateLimiter;
  __instanceId?: string;
};

/**
 * ONE PROCESS, AND HOW THAT IS ENFORCED
 *
 * The concurrency argument in src/checkout/service.ts rests on a fact about JavaScript: a
 * stretch of code with no `await` in it cannot be interrupted, so a read-then-write is
 * indivisible and needs no lock. That is true *within one process* and says nothing about two.
 *
 * What happens with two is worth being precise about, because it is not the failure people
 * expect. They do not race over shared state — they have no shared state. Each process gets
 * its own `globalThis`, so each gets its own Map, and a session created by one is simply
 * "not found" by the other. It breaks completely and immediately rather than subtly and
 * occasionally, which is at least the better failure to have.
 *
 * So the assumption is checked instead of assumed. Node's cluster module knows whether this
 * process was forked as a worker — which is what a process manager running the app with
 * `instances: 4` does — and refusing to start is far better than serving half the sessions to
 * half the users.
 *
 * The check cannot catch everything: a serverless platform runs many isolated instances and
 * none of them is a cluster worker. `instanceId` below is the answer to that. It is minted
 * once per process and reported by GET /api/debug/state, so "am I actually talking to one
 * server?" is a question you can answer by refreshing rather than by reasoning.
 *
 * The real fix is a shared store, and the migration is mechanical: the version counter becomes
 * `UPDATE … WHERE id = ? AND version = ?`, and the uninterrupted stretch becomes a
 * transaction. Nothing in src/checkout/ changes shape.
 */
if (cluster.isWorker) {
  throw new Error(
    "checkout-continuity keeps its sessions in memory, in one process, and this process is a " +
      "cluster worker — each worker would get its own store and sessions would vanish between " +
      "requests. Run a single instance, or swap the Map in src/lib/checkout.ts for a shared store.",
  );
}

/** Identifies this process. If two requests report different values, the note above applies. */
export const instanceId: string = (g.__instanceId ??= uuidv7(Date.now()));

export const stubs: Stubs = (g.__stubs ??= makeStubs());
export const checkout: Checkout = (g.__checkout ??= createCheckout(stubs));

/**
 * How fast one caller may create holds.
 *
 * Twenty a minute is far above any real fan and far below what bulk inventory denial needs.
 * It reads the same injected clock as everything else, so the demo's `advance` knob moves the
 * window too — which is the only way to demonstrate the reset without waiting a minute.
 */
export const holdLimiter: RateLimiter = (g.__limiter ??= createRateLimiter({
  limit: 20,
  windowMs: 60_000,
  now: () => stubs.clock.now(),
}));

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
  holdLimiter.reset();
}

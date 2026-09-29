import cluster from "node:cluster";
import { createCheckout, type Checkout } from "@/checkout/service";
import { makeStubs, type Stubs } from "@/checkout/stubs";
import { v7 as uuidv7 } from "uuid";

/**
 * The single store of sessions and stubs for the process.
 *
 * Attached to `globalThis`, which is normally to be avoided, for two dev-server reasons: Next.js
 * re-runs edited modules, so a module-level `const` would be rebuilt on every save and sessions
 * would vanish mid-demo; and pages, Server Actions and API routes compile into separate module
 * graphs that would each get their own store, so a session created through the API would come
 * back "not found" from a page.
 *
 * In production this is where a database client would go, and nothing in src/checkout/ changes,
 * because the service never assumes its storage is a Map.
 */
const g = globalThis as unknown as {
  __checkout?: Checkout;
  __stubs?: Stubs;
  __instanceId?: string;
};

/**
 * The concurrency argument in service.ts holds within one process and says nothing about two, so
 * this app must run as a single process — and checks rather than trusting.
 *
 * Two processes would not race over shared state; they have none. Each gets its own `globalThis`
 * and its own Map, so a session created by one is "not found" by the other: total and immediate
 * rather than subtle and occasional. Node's cluster module reports whether this process was forked
 * as a worker, which is what a process manager running `instances: 4` produces.
 *
 * It cannot catch everything — a serverless platform runs many isolated instances and none is a
 * cluster worker — which is what `instanceId` is for: minted per process and reported by
 * GET /api/debug/state, so "am I talking to one server?" is answered by refreshing.
 *
 * The real fix is a shared store, and the migration is mechanical: the version counter becomes
 * `UPDATE … WHERE id = ? AND version = ?` and the uninterrupted stretch becomes a transaction.
 */
if (cluster.isWorker) {
  throw new Error(
    "checkout-project keeps its sessions in memory, in one process, and this process is a " +
      "cluster worker — each worker would get its own store and sessions would vanish between " +
      "requests. Run a single instance, or swap the Map in src/lib/checkout.ts for a shared store.",
  );
}

/** Identifies this process; if two requests ever report different values, the note above applies. */
export const instanceId: string = (g.__instanceId ??= uuidv7());

export const stubs: Stubs = (g.__stubs ??= makeStubs());
export const checkout: Checkout = (g.__checkout ??= createCheckout(stubs));

/**
 * Wipe everything back to a fresh start, for POST /api/debug/reset and scripts/demo.sh.
 *
 * Empties the existing objects in place rather than assigning new ones: other modules hold the
 * imported references, so reassigning would leave them pointing at an abandoned store while newly
 * compiled code used the new one.
 */
export function resetAll() {
  stubs.reset();
  checkout._reset();
}

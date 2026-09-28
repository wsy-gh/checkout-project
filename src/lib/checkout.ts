import cluster from "node:cluster";
import { createCheckout, type Checkout } from "@/checkout/service";
import { makeStubs, type Stubs } from "@/checkout/stubs";
import { v7 as uuidv7 } from "uuid";

/**
 * THE ONE RUNNING COPY OF THE APP'S STATE
 *
 * Since everything server-side reaches the checkout through this file, there needs to be exactly
 * one store of sessions and one set of stubs for the whole process, and this is where they live.
 *
 * They are attached to `globalThis`, which is normally something to avoid, for a reason specific
 * to the dev server: when a file is edited, Next.js re-runs the modules that changed, so a plain
 * module-level `const` would be rebuilt on every save and every session would vanish mid-demo.
 * Worse, pages, Server Actions and API routes compile into separate module graphs that could
 * each end up with their *own* store, so a session created through the API would come back "not
 * found" from a page. Hanging the store off the global keeps a single instance for everybody.
 *
 * In production this file is where a database client would go instead, and nothing in
 * src/checkout/ would change, because the service never assumes its storage is a Map.
 */
const g = globalThis as unknown as {
  __checkout?: Checkout;
  __stubs?: Stubs;
  __instanceId?: string;
};

/**
 * ONE PROCESS, AND HOW THAT IS ENFORCED
 *
 * Since the concurrency argument in src/checkout/service.ts rests on a stretch of code with no
 * `await` in it being uninterruptible — which is true within one process and says nothing about
 * two — this app must run as a single process, and rather than trust that, it checks.
 *
 * It is worth being precise about what two processes would do, because it is not the failure
 * people expect: they would not race over shared state, because they have no shared state. Each
 * process gets its own `globalThis`, so each gets its own Map, and a session created by one is
 * simply "not found" by the other. The failure is total and immediate rather than subtle and
 * occasional, which is at least the better kind to have.
 *
 * So the assumption is enforced instead of assumed. Node's cluster module reports whether this
 * process was forked as a worker — which is exactly what a process manager running the app with
 * `instances: 4` produces — and refusing to boot in that case is far better than serving half
 * the sessions to half the users. The check cannot catch everything: a serverless platform runs
 * many isolated instances and none of them is a cluster worker, which is what `instanceId` below
 * is for — it is minted once per process and reported by GET /api/debug/state, so "am I actually
 * talking to one server?" becomes a question you answer by refreshing rather than by reasoning.
 *
 * The real fix is a shared store, and that migration is mechanical: the version counter becomes
 * `UPDATE … WHERE id = ? AND version = ?`, and the uninterrupted stretch becomes a transaction.
 * Nothing in src/checkout/ changes shape.
 */
if (cluster.isWorker) {
  throw new Error(
    "checkout-continuity keeps its sessions in memory, in one process, and this process is a " +
      "cluster worker — each worker would get its own store and sessions would vanish between " +
      "requests. Run a single instance, or swap the Map in src/lib/checkout.ts for a shared store.",
  );
}

/** Identifies this process; if two requests ever report different values, the note above applies. */
export const instanceId: string = (g.__instanceId ??= uuidv7());

export const stubs: Stubs = (g.__stubs ??= makeStubs());
export const checkout: Checkout = (g.__checkout ??= createCheckout(stubs));

/**
 * WIPE EVERYTHING BACK TO A FRESH START. Used by POST /api/debug/reset and at the top of
 * scripts/demo.sh.
 *
 * Since other modules import `checkout` and `stubs` and hold onto those references, this needs
 * to empty the existing objects in place rather than assign new ones: reassigning here would
 * leave every module that already imported them pointing at an abandoned store while newly
 * compiled code used the new one. Emptying in place means every holder sees the same reset.
 */
export function resetAll() {
  stubs.reset();
  checkout._reset();
}

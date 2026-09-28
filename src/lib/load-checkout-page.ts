import { notFound } from "next/navigation";
import { isCheckoutError, type Surface } from "@/checkout/types";
import { checkout, stubs } from "@/lib/checkout";
import { v7 as uuidv7 } from "uuid";

/**
 * LOAD EVERYTHING A CHECKOUT PAGE NEEDS, ON THE SERVER, BEFORE ANY HTML IS SENT.
 *
 * Since the project's central claim is that web and mobile resume the same session, that claim
 * needs to be true in the code and not just described, so both surfaces load their data through
 * this one function — called from the single page at src/app/checkout/[id]/page.tsx that
 * `?surface=mobile` merely re-dresses. The claim holds because there is exactly one piece of
 * code doing the resuming, and the only thing the two surfaces disagree about is wording.
 */
export async function loadCheckoutPage(id: string, surface: Surface) {
  try {
    const session = await checkout.get(id, surface);
    return {
      session,
      // Since a withdrawn listing is a dead end unless the page can offer somewhere else to go,
      // the alternatives are fetched here. The API carries them on its 409, but a page renders
      // the FAILED session directly, so it has to ask for them at load time.
      ...checkout.alternativesFor(session),
      serverNow: stubs.clock.now(),
      priceChange: checkout.priceChange(session),
      listingName: stubs.inventory.get(session.listingId).eventName,
      // A fresh idempotency key for this rendering of the Pay form, minted here on the server.
      //
      // Since it is fixed at render time and travels into PayForm.tsx as a hidden input, every
      // submission of *this* rendered form carries the same value, so a double-click or a browser
      // retry is recognised as a repeat of one attempt rather than a new one; reloading the page
      // mints a new key, which is correct because a reload genuinely is a new attempt (see the
      // note above `complete` in src/checkout/service.ts). It is minted on the server rather than
      // in the browser for a second reason: a value invented in the browser would differ from the
      // one already in the server's HTML, and React would report a hydration mismatch.
      //
      // It is a UUIDv7 rather than the v4 `crypto.randomUUID` returns, so the key sorts by the
      // moment it was minted. Nothing here depends on that — these keys live in a Map discarded
      // on restart — but they are exactly the kind of value that later becomes a database column
      // and appears in other systems' logs, where random ordering is expensive to undo. The
      // timestamp comes from the injected clock like every other instant in this app, so a test
      // that fast-forwards gets keys that agree with its own timeline.
      idempotencyKey: uuidv7({ msecs: stubs.clock.now() }),
    };
  } catch (e) {
    if (isCheckoutError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
}

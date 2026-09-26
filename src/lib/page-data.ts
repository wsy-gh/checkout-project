import { notFound } from "next/navigation";
import { isCheckoutError, type Surface } from "@/checkout/types";
import { checkout, stubs } from "@/lib/checkout";
import { uuidv7 } from "@/lib/uuid";

/**
 * Load everything a checkout page needs, on the server, before any HTML is sent.
 *
 * Both surfaces call this one function — src/app/checkout/[id]/page.tsx for web and
 * src/app/m/checkout/[id]/page.tsx for the simulated phone. That is not a tidiness choice;
 * it is the claim of the whole project made literal. "Web and mobile resume the same
 * session" is true here because there is only one piece of code doing the resuming, and the
 * only thing the two surfaces disagree about is wording.
 */
export async function loadCheckoutPage(id: string, surface: Surface) {
  try {
    const session = await checkout.get(id, surface);
    return {
      session,
      // A withdrawn listing is a dead end unless the page can offer somewhere to go. The
      // API carries these on the 409; a page renders the FAILED session, so it asks here.
      ...checkout.alternativesFor(session),
      serverNow: stubs.clock.now(),
      priceChange: checkout.priceChange(session),
      listingName: stubs.inventory.get(session.listingId).eventName,
      // A fresh key for this rendering of the Pay form, generated here on the server.
      //
      // It travels into src/app/_components/PayForm.tsx as a hidden input. Because it is
      // fixed at render time, every submission of *this* form carries the same value — so a
      // double-click or a browser retry is recognised as a repeat of one attempt rather than
      // a new one. Reloading the page mints a new key, which is correct: that genuinely is a
      // new attempt. See the note above `complete` in src/checkout/service.ts.
      //
      // Generating it on the server also avoids a subtle rendering bug: a value invented in
      // the browser would differ from the one in the server's HTML, and React would complain
      // that the two do not match.
      //
      // It is a UUIDv7 rather than the v4 `crypto.randomUUID()` returns, so the key sorts by
      // the moment it was minted. Nothing here depends on that — the keys live in a Map that
      // is discarded on restart — but these are exactly the values that end up as a database
      // column and in other systems' logs, where random ordering is expensive to undo later.
      // See src/lib/uuid.ts. The time comes from the injected clock like every other instant
      // in this app, so a test that fast-forwards gets keys that agree with its own timeline.
      idempotencyKey: uuidv7(stubs.clock.now()),
    };
  } catch (e) {
    if (isCheckoutError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
}

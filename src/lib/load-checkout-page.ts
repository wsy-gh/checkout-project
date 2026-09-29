import { notFound } from "next/navigation";
import { isCheckoutError, type Surface } from "@/checkout/types";
import { checkout, stubs } from "@/lib/checkout";
import { v7 as uuidv7 } from "uuid";

/**
 * Loads everything a checkout page needs, on the server, before any HTML is sent. Both surfaces
 * come through here from the single page that `?surface=mobile` re-dresses, so "web and mobile
 * resume the same session" is one piece of code rather than two that agree.
 */
export async function loadCheckoutPage(id: string, surface: Surface) {
  try {
    const session = await checkout.get(id, surface);
    return {
      session,
      // The API carries these on its 409, but a page renders the FAILED session directly, so it
      // has to ask at load time — otherwise a withdrawn listing is a dead end.
      ...checkout.alternativesFor(session),
      serverNow: stubs.clock.now(),
      priceChange: checkout.priceChange(session),
      listingName: stubs.inventory.get(session.listingId).eventName,
      // A fresh idempotency key per rendering of the Pay form. Fixed at render time and carried as
      // a hidden input, so every submission of *this* form shares it and a double-click or browser
      // retry is recognised as one attempt; a reload mints a new key, which is correct because a
      // reload is genuinely a new attempt. Minted on the server so it cannot differ from the value
      // already in the HTML, which would be a hydration mismatch.
      //
      // UUIDv7 rather than v4 so keys sort by when they were minted. Nothing here depends on that,
      // but these are exactly the values that later become a database column, where random
      // ordering is expensive to undo. The timestamp comes from the injected clock, so a test that
      // fast-forwards gets keys agreeing with its own timeline.
      idempotencyKey: uuidv7({ msecs: stubs.clock.now() }),
    };
  } catch (e) {
    if (isCheckoutError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
}

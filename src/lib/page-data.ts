import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { isCheckoutError, type Surface } from "@/checkout/types";
import { checkout, stubs } from "@/lib/checkout";

/**
 * Everything a checkout page needs, loaded once on the server. Both surfaces call this,
 * so "web and mobile resume the same session" is literally the same function.
 */
export async function loadCheckoutPage(id: string, surface: Surface) {
  try {
    const session = await checkout.get(id, surface);
    return {
      session,
      serverNow: stubs.clock.now(),
      priceChange: checkout.priceChange(session),
      listingName: stubs.inventory.get(session.listingId).eventName,
      // Minted per render on the server: a retry of the rendered form reuses it, and it
      // never differs between the server HTML and the hydrated tree.
      idempotencyKey: randomUUID(),
    };
  } catch (e) {
    if (isCheckoutError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
}

export const noStore = { headers: { "Cache-Control": "no-store" } };

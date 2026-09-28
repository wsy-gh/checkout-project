"use client";

import { useActionState } from "react";
import type { Session, Surface } from "@/checkout/types";
import { money } from "@/lib/format";
import { pay, type ActionState } from "@/app/actions";

/**
 * THE PAY BUTTON.
 *
 * Since a fan watching a countdown run down needs the button to work the instant the page arrives,
 * this is a real HTML form that posts to a Server Action rather than a button wired to a fetch
 * call. A plain form is submitted by the browser itself, so it works before React has loaded and
 * even if the JavaScript never arrives at all — "the button works now" is worth more here than
 * anything JavaScript adds on top. What hydration adds is only the disabled state and the
 * "Confirming…" label while the action is in flight, useful but not something the fan needs.
 *
 * THE HIDDEN INPUTS
 *
 * Four values ride along with the press, and each is a guard rail:
 *
 *   version          What this screen was looking at. If the session has changed since — the other
 *                    device accepted a new price, say — the server refuses rather than charging
 *                    against information the fan can no longer see.
 *   priceVersion     Which price they are agreeing to pay.
 *   idempotencyKey   Identifies this attempt. Minted once per page render in
 *                    src/lib/load-checkout-page.ts, so a double-click sends the same value twice and
 *                    the server recognises the second as a repeat instead of a new charge.
 *   surface          Whether this is the web or the simulated phone. Analytics only.
 *
 * Since keeping card data out of this application entirely is the goal, there is no card number
 * here and none on the session either: each surface would collect payment details fresh through the
 * provider's own form, and what reaches this action is a short-lived token standing in for them.
 * The checks these values feed are all in `complete` in src/checkout/service.ts.
 */
export function PayForm({ session, surface, idempotencyKey }: { session: Session; surface: Surface; idempotencyKey: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(pay, {});

  return (
    <form action={action}>
      <input type="hidden" name="id" value={session.id} />
      <input type="hidden" name="version" value={session.version} />
      <input type="hidden" name="priceVersion" value={session.priceVersion} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="surface" value={surface} />
      <button type="submit" disabled={pending} aria-busy={pending}>
        {pending ? "Confirming…" : `Pay ${money(session.quotedTotal)}`}
      </button>
      {state.code && <p className="banner bad">Couldn&apos;t complete: {state.code}</p>}
    </form>
  );
}

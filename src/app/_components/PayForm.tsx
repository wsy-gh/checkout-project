"use client";

import { useActionState } from "react";
import type { Session, Surface } from "@/checkout/types";
import { money } from "@/lib/format";
import { pay, type ActionState } from "@/app/actions";

/**
 * A real HTML form posting to a Server Action rather than a button wired to fetch, so it works
 * before React has loaded and even if the JavaScript never arrives — worth more to someone watching
 * a countdown than anything hydration adds, which here is only the disabled state and the
 * "Confirming…" label.
 *
 * The hidden inputs are each a guard rail, all checked by `complete`:
 *
 *   version          What this screen was looking at. Changed since — the other device accepted a
 *                    new price, say — and the server refuses rather than charging against
 *                    information the fan can no longer see.
 *   priceVersion     Which price they are agreeing to pay.
 *   idempotencyKey   Identifies this attempt; minted once per render, so a double-click sends the
 *                    same value twice and the second is recognised as a repeat.
 *   surface          Web or simulated phone. Analytics only.
 *
 * No card number here or on the session: each surface would collect details through the provider's
 * own form, and what reaches this action is a short-lived token standing in for them.
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

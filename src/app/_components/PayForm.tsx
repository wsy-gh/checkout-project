"use client";

import { useActionState } from "react";
import type { Session, Surface } from "@/checkout/types";
import { pay, type ActionState } from "@/app/actions";

/**
 * The Pay button is a real <form> posting to a Server Action, so it works before hydration
 * and without JavaScript. Hydration only adds the pending state and the disabled button.
 *
 * The idempotency key is minted on the server (page render) and carried as a hidden input,
 * so a retry of *this* form submits the same key — and the server replays the outcome
 * instead of charging twice.
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
        {pending ? "Confirming…" : `Pay $${(session.quotedTotal / 100).toFixed(2)}`}
      </button>
      {state.code && <p className="banner bad">Couldn&apos;t complete: {state.code}</p>}
    </form>
  );
}

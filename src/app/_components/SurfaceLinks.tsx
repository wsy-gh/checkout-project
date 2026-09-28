import Link from "next/link";
import type { Session, Surface } from "@/checkout/types";
import { checkoutPath } from "@/lib/routes";

/**
 * LINKS FOR MOVING BETWEEN THE TWO SURFACES, AND FOR LEAVING CHECKOUT.
 *
 * Since the whole point of this demo is watching one session be live in two places at once — which
 * you cannot see if the second surface replaces the first — the cross-surface links open a new tab.
 *
 * They are plain `<a>` tags rather than Next's `<Link>`, also on purpose. Since `<Link>` fetches
 * the next page in the background and swaps it in without a real navigation, using it here would
 * mean the two surfaces quietly sharing one browser-side cache; a plain anchor forces a genuine
 * request, so each surface resolves the session on its own, the way a phone opening a link actually
 * would. That choice has a second benefit: because leaving is a real navigation, the browser Back
 * that returns here is one too, which is exactly the case `pageshow` in SessionSync.tsx covers.
 */
export function SurfaceLinks({ session, surface }: { session: Session; surface: Surface }) {
  const other =
    surface === "web"
      ? { href: checkoutPath(session.id, "mobile"), label: "Open this session on mobile" }
      : { href: checkoutPath(session.id, "web"), label: "Open this session on web" };

  return (
    <nav className="links">
      <a href={other.href} target="_blank" rel="noopener noreferrer">
        {other.label} <NewTab />
      </a>
      {surface === "web" && (
        <a href={`/deeplink/${session.id}`} target="_blank" rel="noopener noreferrer">
          deep link <NewTab />
        </a>
      )}
      <a href={`/listing/${session.listingId}`}>← Back to listing</a>
      <Link href="/">All events</Link>
      {session.status === "ACTIVE" && (
        // Since abandoning checkout does not release the seats — the hold runs out on its own —
        // saying so is more honest than letting the fan assume "back" means "cancel".
        <p className="muted">Leaving keeps your hold until the timer runs out.</p>
      )}
    </nav>
  );
}

/**
 * THE ARROW THAT MARKS A LINK AS OPENING ELSEWHERE.
 *
 * Since "north east arrow" read aloud is noise, the arrow is shown to sighted users but hidden from
 * screen readers, which get the sentence instead — the part that actually carries the warning,
 * because a new tab opening unannounced is disorienting when you cannot see it happen.
 */
function NewTab() {
  return (
    <>
      <span aria-hidden="true">↗</span>
      <span className="sr-only">(opens in a new tab)</span>
    </>
  );
}

import Link from "next/link";
import type { Session, Surface } from "@/checkout/types";
import { copy } from "@/lib/copy";
import { checkoutPath } from "@/lib/routes";

/**
 * Links for moving between the two surfaces, and for leaving checkout.
 *
 * The cross-surface links open a new tab on purpose. The point of this demo is watching one
 * session be live in two places at once, and you cannot see that if the second surface
 * replaces the first.
 *
 * They are plain `<a>` tags rather than Next's `<Link>`, also on purpose. `<Link>` fetches
 * the next page in the background and swaps it in without a real navigation, which is
 * usually what you want — but here it would mean the two surfaces quietly sharing one
 * browser-side cache. A plain anchor forces a genuine request, so each surface has to
 * resolve the session on its own, the way a phone opening a link actually would.
 *
 * That choice has a second benefit. Because leaving is a real navigation, the browser Back
 * that returns here is one too, which is the case `pageshow` in SessionSync.tsx covers.
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
        // Abandoning checkout does not release the seats — the hold runs out on its own.
        // Saying so is more honest than letting the fan assume "back" means "cancel".
        <p className="muted">Leaving keeps your hold until the timer runs out.</p>
      )}
    </nav>
  );
}

/**
 * The arrow that marks a link as opening elsewhere.
 *
 * Sighted users get the arrow; it is hidden from screen readers because "north east arrow"
 * is noise. They get the sentence instead, which is the part that actually carries the
 * warning — a new tab opening unannounced is disorienting when you cannot see it happen.
 */
function NewTab() {
  return (
    <>
      <span aria-hidden="true">↗</span>
      <span className="sr-only">{copy.a11y.opensInNewTab}</span>
    </>
  );
}

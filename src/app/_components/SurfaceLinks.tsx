import Link from "next/link";
import type { Session, Surface } from "@/checkout/types";
import { checkoutPath } from "@/lib/routes";

/**
 * The cross-surface links open a new tab, since the point is watching one session live in two places
 * at once, which you cannot see if the second replaces the first.
 *
 * Plain `<a>` rather than `<Link>`, which would swap the page in client-side and leave the two
 * surfaces sharing one browser cache; a real request makes each surface resolve the session on its
 * own, as a phone opening a link would. It also makes the Back that returns here a real navigation,
 * which is the case `pageshow` in SessionSync covers.
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
        // Leaving does not release the seats; the hold runs out on its own. Saying so beats letting
        // the fan assume "back" means "cancel".
        <p className="muted">Leaving keeps your hold until the timer runs out — release it above to free the seats now.</p>
      )}
    </nav>
  );
}

// "North east arrow" read aloud is noise, so the glyph is hidden from screen readers and the
// sentence carries the warning instead — an unannounced new tab is disorienting when you cannot see it.
function NewTab() {
  return (
    <>
      <span aria-hidden="true">↗</span>
      <span className="sr-only">(opens in a new tab)</span>
    </>
  );
}

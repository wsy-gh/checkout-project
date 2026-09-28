import Link from "next/link";
import { Countdown } from "@/app/_components/Countdown";
import { EventTime } from "@/app/_components/EventTime";
import { RefreshAt } from "@/app/_components/RefreshAt";
import { checkout, stubs } from "@/lib/checkout";
import { money } from "@/lib/format";

// Reads live availability and the server clock, so it must not be prerendered at build.
export const dynamic = "force-dynamic";

// Home: a tiny "event page" so the demo starts somewhere. Lists the seeded listings.
export default async function Home() {
  // Availability is "seats minus live holds". Evaluate the expiry predicate before reading
  // the counter, or an abandoned tab keeps seats off the market until someone re-reads it.
  await checkout.sweepExpired();
  const serverNow = stubs.clock.now();
  const listings = stubs.inventory.all();
  const [resume] = checkout.resumable();

  return (
    <main className="web">
      <h1>Checkout Continuity — demo</h1>
      <p className="muted">
        Pick a listing to start a checkout on web. Then open the same session on the simulated
        mobile surface (link on the checkout page) to see the session move across surfaces.
      </p>

      {resume && (
        // The return path, made visible. This is what a push notification or a "continue
        // checkout" row in the app would land on; the notifier stub logs the same deep link.
        <div className="banner warn">
          <strong>You have a hold in progress</strong>
          <Countdown expiresAt={resume.holdExpiresAt} serverNow={serverNow} compact />
          <p className="muted">
            {stubs.inventory.get(resume.listingId).eventName} · {resume.quantity} {resume.quantity === 1 ? "ticket" : "tickets"}
          </p>
          <div className="actions">
            <Link className="button" href={`/checkout/${resume.id}`}>Resume on web</Link>
            <Link className="button secondary" href={`/deeplink/${resume.id}`}>Resume on mobile</Link>
          </div>
          {/* When it lapses, this page re-renders: banner gone, seats back on sale. */}
          <RefreshAt deadline={resume.holdExpiresAt} serverNow={serverNow} />
        </div>
      )}

      {listings.map((listing) => {
        const closed = serverNow >= stubs.inventory.salesCutoff(listing.id);
        const soldOut = listing.available < 1;
        return (
          <div key={listing.id} className="row listing-row">
            <div>
              <strong>{listing.eventName}</strong>
              <div className="muted">
                {listing.withdrawn ? (
                  "Withdrawn by the seller"
                ) : (
                  <>
                    {listing.section} · {listing.available} left ·{" "}
                    <EventTime startsAt={listing.eventStartsAt} serverNow={serverNow} />
                  </>
                )}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="total">{money(stubs.pricing.current(listing.id).total)}</div>
              {listing.withdrawn ? (
                <span className="muted">unavailable</span>
              ) : soldOut ? (
                // No Buy button when there is nothing to buy. The server would refuse it
                // anyway, but making someone press it to find out is a poor way to say so.
                <span className="muted">sold out</span>
              ) : closed ? (
                // Sales close before the event starts; `create` refuses past that point, so
                // there is no Buy button to press into a rejection.
                <span className="muted">sales closed</span>
              ) : (
                <Link className="button" href={`/listing/${listing.id}`}>Buy</Link>
              )}
            </div>
          </div>
        );
      })}

      {/* The debug routes 404 in a production build, so don't offer links into them there. */}
      {process.env.NODE_ENV !== "production" && (
        <p className="links">
          <Link href="/api/debug/events">event log</Link>
          <Link href="/api/debug/state">stub state</Link>
        </p>
      )}
    </main>
  );
}

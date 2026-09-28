import Link from "next/link";
import { Countdown } from "@/app/_components/Countdown";
import { EventTime } from "@/app/_components/EventTime";
import { RefreshAt } from "@/app/_components/RefreshAt";
import { checkout, stubs } from "@/lib/checkout";
import { readClientId } from "@/lib/client-id";
import { money } from "@/lib/format";

// Since it reads live availability and the server clock, this page must not be prerendered at
// build time — it has to render fresh on every request.
export const dynamic = "force-dynamic";

// Home: a tiny "event page" so the demo starts somewhere, listing the seeded events.
export default async function Home() {
  // Since availability is "seats minus live holds" and that counter only learns a hold has lapsed
  // when someone reads the session, the expiry sweep has to run before we read the counts — otherwise
  // an abandoned tab would keep its seats off the market until someone happened to re-read it.
  await checkout.sweepExpired();
  const serverNow = stubs.clock.now();
  const listings = stubs.inventory.all();
  // Scope the "you have a hold in progress" banner to this browser's own hold. A visitor with no
  // `cid` cookie yet has started nothing, so `readClientId` returns undefined and `resumable(undefined)`
  // would match everyone — so in that case there is nothing of theirs to show and we skip it.
  const clientId = await readClientId();
  const [resume] = clientId ? checkout.resumable(clientId) : [];

  return (
    <main className="web">
      <h1>Checkout Continuity — demo</h1>
      <p className="muted">
        Pick a listing to start a checkout on web. Then open the same session on the simulated
        mobile surface (link on the checkout page) to see the session move across surfaces.
      </p>

      {resume && (
        // The return path, made visible. Since continuity needs something to bring the fan back,
        // this banner is what a push notification or a "continue checkout" row in the app would land
        // on — and the notifier stub logs the same deep link it would carry.
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
          {/* When the hold lapses, this triggers a re-render: the banner disappears and the seats go back
              on sale, all without a background job. */}
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
                // Since there is nothing to buy, there is no Buy button: the server would refuse the
                // press anyway, but making someone press it only to find out is a poor way to say so.
                <span className="muted">sold out</span>
              ) : closed ? (
                // Since sales close before the event starts and `create` refuses past that point,
                // there is no Buy button here to press into a rejection.
                <span className="muted">sales closed</span>
              ) : (
                <Link className="button" href={`/listing/${listing.id}`}>Buy</Link>
              )}
            </div>
          </div>
        );
      })}

      {/* Since the debug routes answer 404 in a production build, don't offer links into them there. */}
      {process.env.NODE_ENV !== "production" && (
        <p className="links">
          <Link href="/api/debug/events">event log</Link>
          <Link href="/api/debug/state">stub state</Link>
        </p>
      )}
    </main>
  );
}

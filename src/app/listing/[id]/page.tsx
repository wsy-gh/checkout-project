import Link from "next/link";
import { notFound } from "next/navigation";
import { EventTime } from "@/app/_components/EventTime";
import { createSession } from "@/app/actions";
import { checkout, stubs } from "@/lib/checkout";
import { money } from "@/lib/format";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> };

/** Why a checkout could not be started, keyed by the error code the Server Action redirected with. */
const CREATE_FAILED: Record<string, string | undefined> = {
  SOLD_OUT: "Those seats went while you were deciding. Try a smaller quantity, or another listing.",
  INVENTORY_WITHDRAWN: "This listing was withdrawn.",
  SALES_CLOSED: "Sales have closed for this event.",
  INVALID_REQUEST: "That quantity isn't available.",
};

/** The "event page": pick a quantity and start a checkout on web or mobile. */
export default async function Listing({ params, searchParams }: Props) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  await checkout.sweepExpired(id); // lapsed holds go back on the rack before we count seats
  const l = stubs.inventory.all().find((x) => x.id === id);
  if (!l) notFound();
  const price = stubs.pricing.current(l.id);
  const serverNow = stubs.clock.now();
  const salesClosed = serverNow >= stubs.inventory.salesCutoff(l.id);
  const soldOut = l.available < 1;

  return (
    <main className="web">
      <h1>{l.eventName}</h1>
      <p className="muted">
        {l.section} · <EventTime startsAt={l.eventStartsAt} serverNow={serverNow} /> · {l.available} left
      </p>
      <p className="total">
        {money(price.total)} <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>each, fees included</span>
      </p>
      {error && <p className="banner bad">{CREATE_FAILED[error] ?? error}</p>}
      {/*
        * Three ways this listing can be unbuyable, each with its own explanation and its own
        * way out. The alternative is showing a Buy button that can only ever come back as a
        * rejection — the server would refuse all three (see `create` in
        * src/checkout/service.ts), but a dead end the fan has to walk into first is not a
        * good screen.
        */}
      {salesClosed && !l.withdrawn ? (
        <Unavailable title="Sales have closed for this event" body="Checkout closes shortly before kickoff, so there is time to get in." />
      ) : l.withdrawn ? (
        <Unavailable title="These tickets are no longer available" body="The seller withdrew this listing." />
      ) : soldOut ? (
        <Unavailable title="These seats are gone" body="Someone else finished checkout first. Other listings for this event may still have seats." />
      ) : (
        <form action={createSession}>
          <input type="hidden" name="listingId" value={l.id} />
          <p>
            <label>
              Qty{" "}
              <select name="quantity" defaultValue={1}>
                {/* Capped at what is actually available. The server checks again anyway,
                    since seats can go between this page rendering and the button press. */}
                {Array.from({ length: l.available }, (_, i) => (
                  <option key={i + 1} value={i + 1}>{i + 1}</option>
                ))}
              </select>
            </label>
          </p>
          {/* Their own row, below the quantity — these are the commitment, not a field. */}
          <div className="actions">
            <button type="submit" name="surface" value="web">Start checkout on web</button>
            <button type="submit" name="surface" value="mobile" className="secondary">Start on mobile</button>
          </div>
        </form>
      )}
      <p className="links"><Link href="/">← all events</Link></p>
    </main>
  );
}

/** One shape for all three reasons a listing cannot be bought right now. */
function Unavailable({ title, body }: { title: string; body: string }) {
  return (
    <div className="banner bad">
      <strong>{title}</strong>
      <p>{body}</p>
      <Link className="button" href="/">Browse other listings</Link>
    </div>
  );
}

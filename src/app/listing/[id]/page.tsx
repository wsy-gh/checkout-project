import Link from "next/link";
import { notFound } from "next/navigation";
import { EventTime } from "@/app/_components/EventTime";
import { createSession } from "@/app/actions";
import { checkout, stubs } from "@/lib/checkout";
import { copy } from "@/lib/copy";
import { money } from "@/lib/format";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> };

/** The "event page": pick a quantity and start a checkout on web or mobile. */
export default async function Listing({ params, searchParams }: Props) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  checkout.sweepExpired(id); // lapsed holds go back on the rack before we count seats
  const l = stubs.inventory.all().find((x) => x.id === id);
  if (!l) notFound();
  const price = stubs.pricing.current(l.id);
  const serverNow = stubs.clock.now();
  const salesClosed = serverNow >= stubs.inventory.salesCutoff(l.id);
  const soldOut = l.available < 1;
  const words = copy.listing;

  return (
    <main className="web">
      <h1>{l.eventName}</h1>
      <p className="muted">
        {l.section} · <EventTime startsAt={l.eventStartsAt} serverNow={serverNow} /> · {words.seatsLeft(l.available)}
      </p>
      <p className="total">{money(price.total)} <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>{words.eachFeesIncluded}</span></p>
      {error && <p className="banner bad">{words.createFailed[error] ?? error}</p>}
      {/*
        * Three ways this listing can be unbuyable, each with its own explanation and its own
        * way out. The alternative is showing a Buy button that can only ever come back as a
        * rejection — the server would refuse all three (see `create` in
        * src/checkout/service.ts), but a dead end the fan has to walk into first is not a
        * good screen.
        */}
      {salesClosed && !l.withdrawn ? (
        <Unavailable title={words.salesClosed.title} body={words.salesClosed.body} />
      ) : l.withdrawn ? (
        <Unavailable title={words.withdrawn.title} body={words.withdrawn.body} />
      ) : soldOut ? (
        <Unavailable title={words.soldOut.title} body={words.soldOut.body} />
      ) : (
        <form action={createSession}>
          <input type="hidden" name="listingId" value={l.id} />
          <p>
            <label>
              {words.quantityLabel}{" "}
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
            <button type="submit" name="surface" value="web">{words.startOnWeb}</button>
            <button type="submit" name="surface" value="mobile" className="secondary">{words.startOnMobile}</button>
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
      <Link className="button" href="/">{copy.listing.browseOthers}</Link>
    </div>
  );
}

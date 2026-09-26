import Link from "next/link";
import { notFound } from "next/navigation";
import { createSession } from "@/app/actions";
import { stubs } from "@/lib/checkout";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> };

/** The "event page": pick a quantity and start a checkout on web or mobile. */
export default async function Listing({ params, searchParams }: Props) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const l = stubs.inventory.all().find((x) => x.id === id);
  if (!l) notFound();
  const price = stubs.pricing.current(l.id);
  const minsToEvent = Math.round((l.eventStartsAt - stubs.clock.now()) / 60000);

  return (
    <main className="web">
      <h1>{l.eventName}</h1>
      <p className="muted">{l.section} · starts in {minsToEvent} min · {l.available} left</p>
      <p className="total">${(price.total / 100).toFixed(2)} <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>each, fees included</span></p>
      {error && <p className="banner bad">{error === "SOLD_OUT" ? "Sold out — someone got there first." : error === "INVENTORY_WITHDRAWN" ? "This listing was withdrawn." : error}</p>}
      <form action={createSession} className="actions">
        <input type="hidden" name="listingId" value={l.id} />
        <label>
          Qty{" "}
          <select name="quantity" defaultValue={1}>
            {Array.from({ length: Math.max(1, l.available) }, (_, i) => (
              <option key={i + 1} value={i + 1}>{i + 1}</option>
            ))}
          </select>
        </label>
        <button type="submit" name="surface" value="web">Start checkout on web</button>
        <button type="submit" name="surface" value="mobile" className="secondary">Start on mobile</button>
      </form>
      <p className="links"><Link href="/">← all events</Link></p>
    </main>
  );
}

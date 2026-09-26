import Link from "next/link";
import { stubs } from "@/lib/checkout";

// Home: a tiny "event page" so the demo starts somewhere. Lists the seeded listings.
export default function Home() {
  const listings = stubs.inventory.all();
  return (
    <main className="web">
      <h1>Checkout Continuity — demo</h1>
      <p className="muted">
        Pick a listing to start a checkout on web. Then open the same session on the simulated
        mobile surface (link on the checkout page) to see the session move across surfaces.
      </p>
      {listings.map((l) => (
        <div key={l.id} className="row" style={{ padding: "12px 0", borderTop: "1px solid var(--line)" }}>
          <div>
            <strong>{l.eventName}</strong>
            <div className="muted">
              {l.section} · {l.available} left · starts in {Math.round((l.eventStartsAt - stubs.clock.now()) / 60000)} min
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="total">${(stubs.pricing.current(l.id).total / 100).toFixed(2)}</div>
            <Link className="button" href={`/listing/${l.id}`}>Buy</Link>
          </div>
        </div>
      ))}
      <p className="links">
        <Link href="/api/debug/events">event log</Link>
        <Link href="/api/debug/state">stub state</Link>
      </p>
    </main>
  );
}

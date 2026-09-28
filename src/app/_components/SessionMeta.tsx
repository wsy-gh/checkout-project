import type { Session, Status, Surface } from "@/checkout/types";

/**
 * A DEVELOPER INSPECTOR, SHOWN ON BOTH CHECKOUT SURFACES.
 *
 * Since the interesting behaviour of this app is server-side and otherwise invisible — you cannot
 * tell by looking at a checkout page that the two surfaces share one record, that stale writes are
 * refused, or that the screen is chosen by status rather than by whichever button you pressed —
 * this panel surfaces the three fields that are the entire contract between a device and the
 * backend, so the demo becomes something you can verify rather than something you take on faith.
 * It is not product UI; a real fan would never see it. Each field says what it is and what to do to
 * watch it work.
 */

/** What each status actually means, since the bare word is not much help on its own. */
const STATUS_MEANING: Record<Status, string> = {
  ACTIVE: "Seats are held for this fan and the countdown is running.",
  PAYMENT_PENDING: "A charge is in flight. The hold is frozen until the provider answers.",
  COMPLETED: "Paid. An order ID is on the session and the seats are sold.",
  EXPIRED: "The hold ran out and the seats went back on sale.",
  FAILED: "Ended without an order. The reason is on the session.",
};

export function SessionMeta({ session, surface }: { session: Session; surface: Surface }) {
  // Labelled by its own heading rather than an aria-label, so the visible title and the announced
  // one cannot drift apart.
  return (
    <section className="inspector" aria-labelledby="inspector-heading">
      <h2 id="inspector-heading">
        Session inspector <span className="tag">dev only</span>
      </h2>

      <dl className="inspector-values">
        <div>
          <dt>Session ID</dt>
          <dd>{session.id}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{session.version}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{session.status}</dd>
        </div>
      </dl>
      <p className="inspector-now">{STATUS_MEANING[session.status]}</p>

      {/* Open on web, where there is room; collapsed inside the narrow phone frame. */}
      <details open={surface === "web"}>
        <summary>What am I looking at?</summary>

        <h3>Session ID</h3>
        <p>
          The server&apos;s record of this checkout: which seats are held, the total it quoted, and when
          the hold expires. Your browser stores none of that. It holds this one ID and asks.
        </p>
        <p className="try">
          <strong>Try it:</strong> open this session on the other surface. Same ID, same screen. Nothing
          is copied between devices — that is all &ldquo;resume on mobile&rdquo; means here.
        </p>

        <h3>Version</h3>
        <p>
          A counter the server increments on every change to the session. Every write has to send back
          the version it last read, and the server refuses anything that doesn&apos;t match.
        </p>
        <p className="try">
          <strong>Try it:</strong> open both surfaces, accept a price change on one, then press Pay on
          the other. The second one is refused with <code>409 STALE_VERSION</code> rather than quietly
          overwriting — it shows you the newer state instead.
        </p>

        <h3>Status</h3>
        <p>
          Where this session sits in its lifecycle: <code>ACTIVE</code> → <code>PAYMENT_PENDING</code> →{" "}
          <code>COMPLETED</code> or <code>FAILED</code>, or <code>ACTIVE</code> → <code>EXPIRED</code>.
          The page picks which screen to render from this value alone.
        </p>
        <p className="try">
          <strong>Try it:</strong> withdraw the listing, change the price, or advance the clock with a
          debug knob, then reload. Same URL, different screen — because the page renders from status,
          never from which button you pressed.
        </p>

        <p className="inspector-foot">
          All three are fields on one record in <code>src/checkout/service.ts</code>. The knobs are{" "}
          <code>POST /api/debug/&#123;price,withdraw,advance,payment&#125;</code>, and{" "}
          <code>GET /api/debug/events</code> shows what the server logged as you went.
        </p>
      </details>
    </section>
  );
}

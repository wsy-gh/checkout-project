import Link from "next/link";
import type { PriceChange, Session, Surface } from "@/checkout/types";
import { acceptPrice, rehold } from "@/app/actions";
import { Countdown } from "./Countdown";
import { PayForm } from "./PayForm";

type Props = {
  session: Session;
  surface: Surface;
  serverNow: number;
  priceChange?: PriceChange;
  idempotencyKey: string;
  listingName: string;
  result?: string;
};

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * One component, one switch on status, no default branch: TypeScript refuses to compile if
 * a status is added and not handled here. Both surfaces render this; the mobile surface
 * passes `surface="mobile"` and gets shorter, action-first copy.
 */
export function RecoveryState({ session: s, surface, serverNow, priceChange, idempotencyKey, listingName, result }: Props) {
  const mobile = surface === "mobile";
  const hidden = (
    <>
      <input type="hidden" name="id" value={s.id} />
      <input type="hidden" name="surface" value={surface} />
    </>
  );

  switch (s.status) {
    case "ACTIVE":
      return (
        <>
          <Header s={s} name={listingName} />
          <Countdown expiresAt={s.holdExpiresAt} serverNow={serverNow} />
          {priceChange ? (
            <div className="banner warn">
              <strong>{mobile ? "Price changed" : "The price changed while you were away"}</strong>
              <p>
                <span className="strike">{money(priceChange.from)}</span> → <strong>{money(priceChange.to)}</strong>
                {!mobile && ". We won't charge the new price until you accept it."}
              </p>
              <form action={acceptPrice} className="actions">
                {hidden}
                <input type="hidden" name="version" value={s.version} />
                <input type="hidden" name="priceVersion" value={priceChange.newPriceVersion} />
                <button type="submit">Accept {money(priceChange.to)}</button>
                <Link className="button secondary" href="/">{mobile ? "Cancel" : "No thanks"}</Link>
              </form>
            </div>
          ) : (
            <>
              {result && result !== "ok" && <ResultBanner code={result} />}
              <PayForm session={s} surface={surface} idempotencyKey={idempotencyKey} />
            </>
          )}
        </>
      );

    case "PAYMENT_PENDING":
      return (
        <>
          <Header s={s} name={listingName} />
          <div className="banner info" aria-live="polite">
            <strong>{mobile ? "Confirming your payment…" : "We're confirming your payment"}</strong>
            <p>{mobile ? "Don't retry. This page will update." : "Don't retry or re-enter your card. Refresh in a moment — this may be finishing on your other device."}</p>
            <a className="button secondary" href="?">Refresh</a>
          </div>
        </>
      );

    case "COMPLETED":
      return (
        <>
          <Header s={s} name={listingName} />
          <div className="banner good">
            <strong>{mobile ? "You're in." : "Order confirmed"}</strong>
            <p>Order <code>{s.orderId}</code> · {money(s.quotedTotal)}</p>
            <Link className="button" href="/">{mobile ? "View tickets" : "Back to events"}</Link>
          </div>
        </>
      );

    case "EXPIRED":
      return (
        <>
          <Header s={s} name={listingName} />
          <div className="banner warn">
            <strong>{mobile ? "Your hold ended" : "Your hold ended while you were away"}</strong>
            <p>{mobile ? "Seats were released. Grab them again?" : "The seats were released so other fans could buy them. You can try again if they're still available."}</p>
            <form action={rehold} className="actions">
              {hidden}
              <button type="submit">Try again</button>
              <Link className="button secondary" href="/">Back</Link>
            </form>
          </div>
        </>
      );

    case "FAILED":
      return (
        <>
          <Header s={s} name={listingName} />
          <div className="banner bad">
            <strong>
              {s.failReason === "INVENTORY_WITHDRAWN"
                ? mobile ? "No longer available" : "These tickets are no longer available"
                : s.failReason === "DECLINED"
                  ? mobile ? "Payment declined" : "Your payment didn't go through"
                  : mobile ? "Couldn't confirm payment" : "We couldn't confirm your payment"}
            </strong>
            <p>
              {s.failReason === "INVENTORY_WITHDRAWN" && (mobile ? "The seller pulled this listing." : "The seller withdrew this listing. Your seats were released and you were not charged.")}
              {s.failReason === "DECLINED" && (mobile ? "Your seats were released. Try another card." : "Your seats were released. You can try again with another payment method.")}
              {s.failReason === "PENDING_TIMEOUT" && (mobile ? "If you were charged, we'll refund it." : "The payment provider never confirmed. If you were charged, it will be refunded automatically.")}
            </p>
            <div className="actions">
              <Link className="button" href={`/listing/${s.listingId}`}>{s.failReason === "INVENTORY_WITHDRAWN" ? "See similar" : "Try again"}</Link>
              <Link className="button secondary" href="/">Back</Link>
            </div>
          </div>
        </>
      );
  }
}

function Header({ s, name }: { s: Session; name: string }) {
  return (
    <div className="row">
      <div>
        <h1>{name}</h1>
        <p className="muted">{s.quantity} ticket{s.quantity > 1 ? "s" : ""}</p>
      </div>
      <div className="total">{money(s.quotedTotal)}</div>
    </div>
  );
}

function ResultBanner({ code }: { code: string }) {
  const copy: Record<string, string> = {
    STALE_VERSION: "This page was out of date. Here's the current state — please try again.",
    PRICE_CHANGED: "The price changed. Review it below before paying.",
    IN_PROGRESS_ELSEWHERE: "Payment is already in progress on another device.",
  };
  return <p className="banner warn">{copy[code] ?? `Couldn't complete: ${code}`}</p>;
}

import Link from "next/link";
import type { Alternative, FailReason, PriceChange, Session, Surface } from "@/checkout/types";
import { acceptPrice, rehold, releaseHold } from "@/app/actions";
import { money } from "@/lib/format";
import { Countdown } from "./Countdown";
import { PayForm } from "./PayForm";
import { SessionSync } from "./SessionSync";

type Props = {
  session: Session;
  surface: Surface;
  serverNow: number;
  priceChange?: PriceChange;
  idempotencyKey: string;
  listingName: string;
  alternatives?: Alternative[];
  result?: string;
};

/**
 * The screen is decided by the session's status alone — not by which button was pressed or what the
 * last request returned — so a phone opening a link and a laptop refreshing after a failed payment
 * reach the same screen. There is no "resumed" state to get into.
 *
 * Status cannot always explain what just *happened*, which is what `result` is for, and why the
 * banner is drawn here rather than inside one branch (see `refusalToShow`).
 *
 * Surface wording is inline via `t(web, mobile)`, the phone getting the shorter copy. English only;
 * a real product would lift these into a translation layer.
 */
export function RecoveryState(props: Props) {
  const { session, listingName, priceChange, result } = props;
  const refusal = refusalToShow(result, session, priceChange);

  return (
    <>
      <Header s={session} name={listingName} />
      {refusal && <ResultBanner code={refusal} />}
      <StateBody {...props} />
    </>
  );
}

// Codes the status panel already spells out in full, so a banner repeating them would be noise —
// and noise on an error screen is how people learn to stop reading error screens.

const PANEL_SAYS_IT: ReadonlySet<string> = new Set([
  "PAYMENT_DECLINED",
  "EXPIRED",
  "ALREADY_COMPLETED",
  "ALREADY_FAILED",
  "IN_PROGRESS_ELSEWHERE",
]);

/** What a refused action is told to the fan, keyed by the domain's error code. */
const REJECTED: Record<string, string | undefined> = {
  STALE_VERSION: "This page was out of date. Here's the current state — please try again.",
  PRICE_CHANGED: "The price changed. Review it below before paying.",
  IN_PROGRESS_ELSEWHERE: "Payment is already in progress on another device.",
  INVALID_REQUEST: "Something about that request didn't look right. Please try again.",
  SOLD_OUT: "Another fan took those seats while you were away. Other listings for this event may still have some.",
  SALES_CLOSED: "Sales have closed for this event, so the hold can't be renewed.",
  INVENTORY_WITHDRAWN: "The seller withdrew this listing, so those seats can't be held again.",
};

/**
 * Which refusal, if any, needs saying in words. Pressing "Try again" on an expired hold whose seats
 * another fan has taken leaves the session still EXPIRED, so the screen would redraw identically
 * and the button would appear to do nothing. "Say it unless the panel already does" catches every
 * rejection that would otherwise leave the screen looking unchanged.
 */
function refusalToShow(result: string | undefined, s: Session, priceChange?: PriceChange): string | undefined {
  if (!result || result === "ok") return undefined;
  // The price panel already shows both numbers and the button to accept the new one.
  if (result === "PRICE_CHANGED" && priceChange) return undefined;
  // Worth saying to someone re-holding an expired session, redundant once the panel is itself
  // about the withdrawal.
  if (result === "INVENTORY_WITHDRAWN" && s.status === "FAILED") return undefined;
  if (PANEL_SAYS_IT.has(result)) return undefined;
  return result;
}

/** Every way a checkout can end badly, one [web, mobile] wording pair per reason. */
const FAILURE: Record<FailReason, { title: [string, string]; body: [string, string]; action: [string, string] }> = {
  INVENTORY_WITHDRAWN: {
    title: ["These tickets are no longer available", "No longer available"],
    body: ["The seller withdrew this listing. Your seats were released and you were not charged.", "The seller pulled this listing."],
    action: ["Browse other listings", "Browse"],
  },
  DECLINED: {
    title: ["Your payment didn't go through", "Payment declined"],
    body: ["Your seats were released. You can try again with another payment method.", "Your seats were released. Try another card."],
    action: ["Try again", "Try again"],
  },
  PENDING_TIMEOUT: {
    title: ["We couldn't confirm your payment", "Couldn't confirm payment"],
    body: ["The payment provider never confirmed. If you were charged, it will be refunded automatically.", "If you were charged, we'll refund it."],
    action: ["Try again", "Try again"],
  },
};

/**
 * No `default` branch, deliberately: TypeScript knows `status` has exactly five values, so adding a
 * sixth and forgetting this file fails the build rather than showing a fan a blank screen.
 */
function StateBody({ session: s, surface, serverNow, priceChange, idempotencyKey, alternatives }: Props) {
  const t = (web: string, mobile: string) => (surface === "mobile" ? mobile : web);
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
          <Countdown expiresAt={s.holdExpiresAt} serverNow={serverNow} />
          {priceChange ? (
            <div className="banner warn">
              <strong>{t("The price changed while you were away", "Price changed")}</strong>
              <p>
                <span className="strike">{money(priceChange.from)}</span> → <strong>{money(priceChange.to)}</strong>
                {t(". We won't charge the new price until you accept it.", "")}
              </p>
              <form action={acceptPrice} className="actions">
                {hidden}
                <input type="hidden" name="version" value={s.version} />
                <input type="hidden" name="priceVersion" value={priceChange.newPriceVersion} />
                <button type="submit">Accept {money(priceChange.to)}</button>
                <Link className="button secondary" href="/">{t("No thanks", "Cancel")}</Link>
              </form>
            </div>
          ) : (
            <PayForm session={s} surface={surface} idempotencyKey={idempotencyKey} />
          )}

          {/* Giving up the hold on purpose. Kept below Pay and visually quieter than it, because the
              two are opposite intentions and a misclick here costs the fan their seats. Offered
              alongside the price panel too: declining a rise is a reason to let the seats go. */}
          <form action={releaseHold} className="release">
            {hidden}
            <button type="submit" className="secondary">{t("Release these seats", "Release seats")}</button>
            <span className="muted">
              {t(
                "Frees them for other fans now, rather than when the timer runs out — start again from the listing to change the quantity.",
                "Frees them now. Start again to change the quantity.",
              )}
            </span>
          </form>
        </>
      );

    case "PAYMENT_PENDING":
      return (
        <div className="banner info" aria-live="polite">
          <strong>{t("We're confirming your payment", "Confirming your payment…")}</strong>
          <p>
            {t(
              "Don't retry or re-enter your card. This page updates itself — it may be finishing on your other device.",
              "Don't retry. This page will update.",
            )}
          </p>
          <noscript>
            <a className="button secondary" href="?">Refresh</a>
          </noscript>
        </div>
      );

    case "COMPLETED":
      return (
        <div className="banner good">
          <strong>{t("Order confirmed", "You're in.")}</strong>
          <p>Order {s.orderId} · {money(s.quotedTotal)}</p>
          <Link className="button" href="/">{t("Back to events", "View tickets")}</Link>
        </div>
      );

    case "EXPIRED":
      return (
        <div className="banner warn">
          <strong>{t("Your hold ended while you were away", "Your hold ended")}</strong>
          <p>
            {t(
              "The seats were released so other fans could buy them. You can try again if they're still available.",
              "Seats were released. Grab them again?",
            )}
          </p>
          <form action={rehold} className="actions">
            {hidden}
            <button type="submit">Try again</button>
            <Link className="button secondary" href="/">Back</Link>
          </form>
        </div>
      );

    case "FAILED": {
      const failure = FAILURE[s.failReason];
      const withdrawn = s.failReason === "INVENTORY_WITHDRAWN";
      const pick = ([web, mobile]: [string, string]) => (surface === "mobile" ? mobile : web);
      return (
        <div className="banner bad">
          <strong>{pick(failure.title)}</strong>
          <p>{pick(failure.body)}</p>
          {withdrawn && alternatives?.length ? (
            <ul className="alts">
              {alternatives.map((a) => (
                <li key={a.id}>
                  <Link href={`/listing/${a.id}`}>{a.eventName}</Link>
                  <span className="muted"> · {a.section} · {money(a.total)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="actions">
            {/* Never send them back to the withdrawn listing — it is the dead end they just hit. */}
            {withdrawn ? (
              <Link className="button" href="/">{pick(failure.action)}</Link>
            ) : (
              <Link className="button" href={`/listing/${s.listingId}`}>{pick(failure.action)}</Link>
            )}
            <Link className="button secondary" href="/">Back</Link>
          </div>
        </div>
      );
    }
  }
}

// Shown above every status panel, which makes it the natural home for SessionSync (renders nothing).

function Header({ s, name }: { s: Session; name: string }) {
  return (
    <div className="row">
      <SessionSync sessionId={s.id} version={s.version} pending={s.status === "PAYMENT_PENDING"} />
      <div>
        <h1>{name}</h1>
        <p className="muted">{s.quantity} {s.quantity === 1 ? "ticket" : "tickets"}</p>
      </div>
      <div className="total">{money(s.quotedTotal)}</div>
    </div>
  );
}

// The fallback is deliberately ugly rather than absent: an unworded code means a missing entry in
// REJECTED above, and a visibly odd sentence on screen is how that bug gets found.

function ResultBanner({ code }: { code: string }) {
  return (
    <p className="banner warn" role="status">
      {REJECTED[code] ?? `Couldn't complete: ${code}`}
    </p>
  );
}

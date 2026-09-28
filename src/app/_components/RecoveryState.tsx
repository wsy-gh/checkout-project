import Link from "next/link";
import type { Alternative, FailReason, PriceChange, Session, Surface } from "@/checkout/types";
import { acceptPrice, rehold } from "@/app/actions";
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
 * DECIDES WHAT THE FAN ACTUALLY SEES, BASED ON ONE THING: THE SESSION'S STATUS.
 *
 * Since resuming has to work identically no matter how the fan arrived, this decides the screen
 * from the status alone — not from which button they pressed, not from what the last request
 * returned. A phone opening a link for the first time and a laptop refreshing after a failed
 * payment run the same code and reach the same screen, because they are looking at the same
 * session; there is no "resumed" state to get into.
 *
 * Status decides the screen but cannot always explain what just happened, which is what `result`
 * is for, and it is why the banner is drawn out here rather than inside one branch — see
 * `refusalToShow` below.
 *
 * WORDING. Since the two surfaces differ only in wording and the difference is small, it is kept
 * inline: `t(web, mobile)` below picks between them, giving the phone the shorter, more direct copy
 * because it has less room and its reader is usually mid-task. English only — a real product would
 * lift these into a translation layer, which the README notes as future work.
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

/**
 * REJECTIONS THE STATUS PANEL BELOW ALREADY SPELLS OUT IN FULL.
 *
 * Since a declined card already renders the "your payment didn't go through, your seats were
 * released" screen — which says everything a banner would and says it better — repeating it on top
 * would be noise, and noise on an error screen is how people learn to stop reading error screens.
 * So codes in this set are the ones `refusalToShow` suppresses.
 */
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
 * WHICH REFUSAL, IF ANY, THE FAN HAS TO BE TOLD ABOUT IN WORDS.
 *
 * Since pressing "Try again" on an expired hold whose seats another fan has taken leaves the
 * session still EXPIRED, the screen would redraw identically and the button would appear to do
 * nothing — worse than an error — so this function exists to surface a message in that case. It is
 * written as "say it unless the panel already does", because that same shape catches every
 * rejection that would otherwise leave the screen looking unchanged.
 */
function refusalToShow(result: string | undefined, s: Session, priceChange?: PriceChange): string | undefined {
  if (!result || result === "ok") return undefined;
  // The price panel already shows both numbers and the button to accept the new one.
  if (result === "PRICE_CHANGED" && priceChange) return undefined;
  // Worth saying to someone trying to re-hold an expired session, but redundant once the withdrawal
  // is the thing the panel itself is already about.
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
 * THE PANEL FOR THE SESSION'S CURRENT STATUS, AND NOTHING ELSE.
 *
 * The switch has no `default` branch, deliberately. Since TypeScript can tell that `status` has
 * exactly five possible values, if someone adds a sixth and forgets this file the build fails
 * instead of a fan meeting a blank screen — a compile error standing in for a test nobody would
 * have thought to write.
 */
function StateBody({ session: s, surface, serverNow, priceChange, idempotencyKey, alternatives }: Props) {
  // Pick the web or the mobile wording for one phrase; the phone gets the shorter one.
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
            {/* Since the withdrawn listing is exactly the dead end the fan just hit, never send them
                back to it — offer the home page instead. */}
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

/**
 * THE EVENT NAME, HOW MANY SEATS, AND THE TOTAL — shown above every status panel.
 *
 * Since it is the one thing every screen renders, it is the natural home for SessionSync, which
 * keeps the page from going stale (see SessionSync.tsx; it renders nothing visible).
 */
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

/**
 * SHOWN WHEN THE SERVER TURNED DOWN SOMETHING THE FAN JUST DID AND THE PAGE RE-RENDERED FROM TRUTH.
 *
 * The fallback is deliberately ugly rather than absent, because an unworded code is a bug — a
 * missing entry in REJECTED above — and a visibly odd sentence on screen is how that bug gets found.
 */
function ResultBanner({ code }: { code: string }) {
  return (
    <p className="banner warn" role="status">
      {REJECTED[code] ?? `Couldn't complete: ${code}`}
    </p>
  );
}

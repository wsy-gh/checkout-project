import Link from "next/link";
import type { Alternative, PriceChange, Session, Surface } from "@/checkout/types";
import { acceptPrice, rehold } from "@/app/actions";
import { copy } from "@/lib/copy";
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
 * Decides what the fan actually sees, based on one thing: the session's status.
 *
 * Not on which button they pressed, not on what the last request returned — just the status.
 * That is what makes resuming work. A phone opening a link for the first time and a laptop
 * refreshing after a failed payment run the same code and reach the same screen, because
 * they are looking at the same session. There is no "resumed" state to get into.
 *
 * Status decides the screen, but it cannot always explain what just happened, which is what
 * `result` is for and why the banner is drawn out here rather than inside one branch. See
 * `refusalToShow` below.
 *
 * Both surfaces render this. The mobile one passes `surface="mobile"` and gets shorter,
 * more direct wording — the layout difference lives in the pages themselves.
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
 * Rejections the panel below already spells out in full.
 *
 * A declined card renders the "your payment didn't go through, your seats were released"
 * screen, which says everything a banner would and says it better. Repeating it on top is
 * noise, and noise on an error screen is how people learn to stop reading error screens.
 */
const PANEL_SAYS_IT: ReadonlySet<string> = new Set([
  "PAYMENT_DECLINED",
  "EXPIRED",
  "ALREADY_COMPLETED",
  "ALREADY_FAILED",
  "IN_PROGRESS_ELSEWHERE",
]);

/**
 * Which refusal, if any, the fan has to be told about in words.
 *
 * The case this exists for: pressing "Try again" on an expired hold after another fan has
 * taken the seats. The re-hold is refused, the session is still EXPIRED, so the screen
 * redraws identically — and a button that visibly does nothing is worse than an error. The
 * same shape catches every rejection that leaves the screen looking unchanged, so the rule
 * is stated the other way round: say it unless the panel already does.
 *
 * Note that an unrecognised code still shows something (see `ResultBanner`). A refusal the
 * fan never sees is the bug this function exists to prevent, so the default is to speak.
 */
function refusalToShow(result: string | undefined, s: Session, priceChange?: PriceChange): string | undefined {
  if (!result || result === "ok") return undefined;
  // The price panel shows both numbers and the button to accept the new one.
  if (result === "PRICE_CHANGED" && priceChange) return undefined;
  // Worth saying to someone trying to re-hold an expired session; redundant once the
  // withdrawal is the thing the panel is already about.
  if (result === "INVENTORY_WITHDRAWN" && s.status === "FAILED") return undefined;
  if (PANEL_SAYS_IT.has(result)) return undefined;
  return result;
}

/**
 * The panel for the session's current status, and nothing else.
 *
 * The switch has no `default` branch, deliberately. TypeScript can tell that `status` has
 * exactly five possible values, so if someone adds a sixth and forgets this file, the build
 * fails instead of a fan meeting a blank screen. It is a compile error standing in for a test
 * nobody would have thought to write.
 */
function StateBody({ session: s, surface, serverNow, priceChange, idempotencyKey, alternatives }: Props) {
  // `surface` picks between the two wordings for every phrase below. Everything the fan
  // reads comes from src/lib/copy.ts; nothing is written inline here.
  const words = copy.checkout;
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
              <strong>{words.priceChanged.title[surface]}</strong>
              <p>
                <span className="strike">{money(priceChange.from)}</span> → <strong>{money(priceChange.to)}</strong>
                {words.priceChanged.note[surface]}
              </p>
              <form action={acceptPrice} className="actions">
                {hidden}
                <input type="hidden" name="version" value={s.version} />
                <input type="hidden" name="priceVersion" value={priceChange.newPriceVersion} />
                <button type="submit">{words.priceChanged.accept(money(priceChange.to))}</button>
                <Link className="button secondary" href="/">{words.priceChanged.decline[surface]}</Link>
              </form>
            </div>
          ) : (
            <PayForm session={s} surface={surface} idempotencyKey={idempotencyKey} />
          )}
        </>
      );

    case "PAYMENT_PENDING":
      return (
        <>
          <div className="banner info" aria-live="polite">
            <strong>{words.confirming.title[surface]}</strong>
            <p>{words.confirming.body[surface]}</p>
            <noscript><a className="button secondary" href="?">{words.confirming.refresh[surface]}</a></noscript>
          </div>
        </>
      );

    case "COMPLETED":
      return (
        <>
          <div className="banner good">
            <strong>{words.completed.title[surface]}</strong>
            <p>{words.completed.orderLine(s.orderId, money(s.quotedTotal))}</p>
            <Link className="button" href="/">{words.completed.done[surface]}</Link>
          </div>
        </>
      );

    case "EXPIRED":
      return (
        <>
          <div className="banner warn">
            <strong>{words.expired.title[surface]}</strong>
            <p>{words.expired.body[surface]}</p>
            <form action={rehold} className="actions">
              {hidden}
              <button type="submit">{words.expired.retry[surface]}</button>
              <Link className="button secondary" href="/">{words.expired.back[surface]}</Link>
            </form>
          </div>
        </>
      );

    case "FAILED": {
      const failure = words.failed[s.failReason];
      const withdrawn = s.failReason === "INVENTORY_WITHDRAWN";
      return (
        <>
          <div className="banner bad">
            <strong>{failure.title[surface]}</strong>
            <p>{failure.body[surface]}</p>
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
              {/* Never send the fan back to the listing that just vanished. */}
              {withdrawn ? (
                <Link className="button" href="/">{failure.action[surface]}</Link>
              ) : (
                <Link className="button" href={`/listing/${s.listingId}`}>{failure.action[surface]}</Link>
              )}
              <Link className="button secondary" href="/">{words.expired.back[surface]}</Link>
            </div>
          </div>
        </>
      );
    }
  }
}

/**
 * The event name, how many seats, and the total — shown above every status panel.
 *
 * Being the one thing every screen renders makes it the natural home for SessionSync, which
 * keeps the page from going stale. See SessionSync.tsx; it renders nothing visible.
 */
function Header({ s, name }: { s: Session; name: string }) {
  return (
    <div className="row">
      <SessionSync sessionId={s.id} version={s.version} pending={s.status === "PAYMENT_PENDING"} />
      <div>
        <h1>{name}</h1>
        <p className="muted">{copy.checkout.seats(s.quantity)}</p>
      </div>
      <div className="total">{money(s.quotedTotal)}</div>
    </div>
  );
}

/**
 * Shown when the server turned down something the fan just did and the page re-rendered from
 * the truth. The fallback is deliberately ugly rather than absent: an unworded code is a bug
 * in src/lib/copy.ts, and a visibly odd sentence is how it gets found. Silence is not.
 */
function ResultBanner({ code }: { code: string }) {
  return (
    <p className="banner warn" role="status">
      {copy.checkout.rejected[code] ?? `Couldn't complete: ${code}`}
    </p>
  );
}

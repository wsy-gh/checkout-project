"use client";

import { useRouter } from "next/navigation";
import { useElapsed } from "./useElapsed";

/**
 * THE HOLD TIMER
 *
 * Since the fan is racing a deadline they cannot see on their own, this needs to show how much
 * time is left on the hold and keep that number correct as it counts down. It is implemented by
 * having the server send two numbers — when the hold expires (`expiresAt`) and what time the
 * server thought it was when it rendered (`serverNow`) — and subtracting them. That subtraction
 * is done on the server as well as the browser, for the following reasons: the very first HTML
 * the fan receives already contains the right number, so a correct, meaningful countdown is on
 * screen before any JavaScript has loaded, which for someone under time pressure is the single
 * most important thing on the page.
 *
 * The second-by-second ticking is added afterwards by useElapsed.ts. Since a device's own clock
 * can jump (a phone re-syncs the moment it reconnects), useElapsed measures *elapsed* time
 * rather than re-reading the clock, and it restarts that measurement whenever a re-fetch hands
 * this component a fresh `serverNow` — which is what stops a re-fetched page from counting the
 * same elapsed seconds twice.
 *
 * THE HIDDEN SCREEN-READER LINE AT THE BOTTOM
 *
 * Since the visible digits change every second, wrapping them in a screen-reader live region
 * would make the reader announce a new number every second, talking over everything else on the
 * page and making it unusable. So this needs to keep the digits silent and carry announcements
 * on a separate hidden line instead, and that line is written to change only at the few moments
 * worth interrupting someone for — two minutes left, thirty seconds left, and expired — because
 * React leaves the DOM node alone while the string is unchanged, so each of those is announced
 * exactly once rather than repeatedly.
 */
export function Countdown({
  expiresAt,
  serverNow,
  compact = false,
}: {
  expiresAt: number;
  serverNow: number;
  compact?: boolean;
}) {
  const router = useRouter();
  const elapsed = useElapsed(serverNow);
  const ms = Math.max(0, expiresAt - serverNow - elapsed);

  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const urgent = ms < 2 * 60000;
  const ended = ms === 0;

  // Since a live region around the digits would talk over the whole page (see the header note),
  // this announcement string is deliberately allowed to change only when the fan crosses a
  // boundary worth interrupting them for, so the screen reader speaks at those points and stays
  // quiet in between.
  const announcement = ended ? "Your hold has ended." : ms <= 30_000 ? "30 seconds left." : urgent ? "2 minutes left on your hold." : "";

  return (
    <>
      <div className={`countdown${urgent ? " urgent" : ""}${compact ? " compact" : ""}`}>
        {ended ? "Hold ended" : `${m}:${s.toString().padStart(2, "0")}`}
        <span className="countdown-label">{ended ? "— refresh to continue" : "left on your hold"}</span>
      </div>

      {/*
        * Since a hold can run out while the fan simply sits on the page — a case with no other
        * trigger, and the simulated phone frame has no browser refresh button of its own — this
        * needs to offer an explicit way to act once the timer reaches zero. It is implemented as
        * a button calling `router.refresh()`, which re-runs the server render; that render reads
        * the session, notices the deadline has passed, and draws the "your hold ended" screen
        * with its "try again". It is left off the compact home-page banner, which has its own
        * controls, so the button only appears where it is actually the fan's way forward.
        */}
      {ended && !compact && (
        <button type="button" className="button" onClick={() => router.refresh()}>
          Refresh
        </button>
      )}

      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </>
  );
}

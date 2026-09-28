"use client";

import { useRouter } from "next/navigation";
import { useElapsed } from "./useElapsed";

/**
 * The hold timer.
 *
 * Two numbers arrive from the server: when the hold expires, and what time the server
 * thought it was when it rendered. Subtracting them gives the time remaining, and that
 * subtraction happens on the server too — so the first HTML the fan receives already has the
 * right number in it, before any JavaScript has loaded. For someone under time pressure,
 * that is the single most important thing on the page.
 *
 * The ticking is added afterwards by useElapsed.ts, which measures elapsed time from
 * `serverNow` rather than reading the clock, and restarts if the page re-fetches and hands us
 * a fresh `serverNow`.
 *
 * ABOUT THE SCREEN-READER LINE AT THE BOTTOM
 *
 * The visible digits change every second. Wrapping them in a live region would make a screen
 * reader announce a new number every second, talking over everything else on the page and
 * making it unusable. So the digits are silent, and a separate hidden line carries a message
 * that only changes at moments worth interrupting someone for: two minutes left, thirty
 * seconds left, and expired. React leaves the DOM alone when a string is unchanged, so those
 * are announced once each rather than repeatedly.
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

  // Announce at thresholds, not every second. The digits change once a second, so a live
  // region wrapped around them would talk over everything else on the page; this string only
  // changes when the fan crosses a boundary worth interrupting them for.
  const announcement = ended ? "Your hold has ended." : ms <= 30_000 ? "30 seconds left." : urgent ? "2 minutes left on your hold." : "";

  return (
    <>
      <div className={`countdown${urgent ? " urgent" : ""}${compact ? " compact" : ""}`}>
        {ended ? "Hold ended" : `${m}:${s.toString().padStart(2, "0")}`}
        <span className="countdown-label">{ended ? "— refresh to continue" : "left on your hold"}</span>
      </div>

      {/*
        * An explicit way to act once the hold has run out. The page re-fetches itself on Back
        * and across tabs (SessionSync), but a hold expiring while the fan simply sits on the
        * page has no such trigger, and the simulated phone has no browser refresh button of its
        * own. So the timer offers one. `router.refresh()` re-runs the server render, which reads
        * the session, notices the deadline passed, and draws the "your hold ended" screen with
        * its "try again". Left off the compact home-page banner, which has its own controls.
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

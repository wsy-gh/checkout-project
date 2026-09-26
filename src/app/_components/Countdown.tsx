"use client";

import { copy } from "@/lib/copy";
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
 * The ticking is added afterwards by useElapsed.ts, which explains why it measures elapsed
 * time rather than reading the clock.
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
  const elapsed = useElapsed();
  const ms = Math.max(0, expiresAt - serverNow - elapsed);

  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const urgent = ms < 2 * 60000;

  // Announce at thresholds, not every second. The digits change once a second, so a live
  // region wrapped around them would talk over everything else on the page; this string only
  // changes when the fan crosses a boundary worth interrupting them for.
  const announcement =
    ms === 0 ? copy.a11y.holdEnded : ms <= 30_000 ? copy.a11y.thirtySeconds : urgent ? copy.a11y.twoMinutes : "";

  return (
    <>
      <div className={`countdown${urgent ? " urgent" : ""}${compact ? " compact" : ""}`}>
        {ms === 0 ? "Hold ended" : `${m}:${s.toString().padStart(2, "0")}`}
        <span className="countdown-label">{ms === 0 ? "— refresh to continue" : "left on your hold"}</span>
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </>
  );
}

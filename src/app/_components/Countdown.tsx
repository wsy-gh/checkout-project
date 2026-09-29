"use client";

import { useRouter } from "next/navigation";
import { useElapsed } from "./useElapsed";

/**
 * The hold timer. The server sends both instants — when the hold expires and what time it thought it
 * was when rendering — and the difference is computed on the server too, so the first HTML already
 * carries a correct countdown before any JavaScript loads. For someone under time pressure that is
 * the most important thing on the page. useElapsed adds the ticking.
 *
 * The digits are kept out of a live region: changing every second, they would make a screen reader
 * announce a new number every second and talk over the whole page. Announcements go on the hidden
 * line instead, which changes only at the moments worth interrupting someone for — two minutes,
 * thirty seconds, expired — so React leaves the node alone between them and each is announced once.
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

  // Changes only when the fan crosses a boundary worth interrupting them for, so the screen reader
  // speaks at those points and stays quiet in between.
  const announcement = ended ? "Your hold has ended." : ms <= 30_000 ? "30 seconds left." : urgent ? "2 minutes left on your hold." : "";

  return (
    <>
      <div className={`countdown${urgent ? " urgent" : ""}${compact ? " compact" : ""}`}>
        {ended ? "Hold ended" : `${m}:${s.toString().padStart(2, "0")}`}
        <span className="countdown-label">{ended ? "— refresh to continue" : "left on your hold"}</span>
      </div>

      {/* A hold can run out while the fan just sits there, with no other trigger — and the phone
          frame has no refresh button of its own. `router.refresh()` re-runs the server render, which
          notices the deadline passed and draws the "hold ended" screen. Left off the compact home
          banner, which has its own controls. */}
      {ended && !compact && (
        <button type="button" className="button countdown-refresh" onClick={() => router.refresh()}>
          Refresh
        </button>
      )}

      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </>
  );
}

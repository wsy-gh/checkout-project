"use client";

import { useEffect, useState } from "react";

/**
 * Milliseconds elapsed since a server-time anchor, ticking once a second. Shared by the hold
 * countdown and the event clock. The server sends the numbers that matter and the caller
 * subtracts them, so the first render is already correct; this only adds the passage of time.
 *
 * `anchor` is the caller's `serverNow`, passed in so a change can be detected and the count reset.
 * A checkout page can re-fetch itself in place (SessionSync does, on a Back navigation), handing
 * the caller a fresh `serverNow` mid-life. Without the reset, the hook would keep counting from
 * the original mount while the caller subtracted that elapsed time from the *new* anchor —
 * counting the same gap twice and jumping the timer forward by however long the page had been open.
 *
 * It measures elapsed time with `performance.now()` rather than reading the wall clock each tick,
 * because wall-clock time moves for reasons unrelated to time passing — most sharply when a phone
 * reconnects and the OS re-syncs, which can jump it minutes — and a countdown doing arithmetic on
 * it would jump too. `performance.now()` only moves forward at a steady rate and keeps counting
 * while a tab is backgrounded, so a throttled interval reports true elapsed time rather than drift.
 *
 * It returns 0 on the first render because the server has no `performance.now()` and never runs
 * the effect, so the browser's first render must match that exactly or React reports a hydration
 * mismatch.
 */
export function useElapsed(anchor: number, intervalMs = 1000): number {
  const [elapsed, setElapsed] = useState(0);
  const [seenAnchor, setSeenAnchor] = useState(anchor);

  // Reset during render rather than in the effect: this is React's prescribed way to reset state
  // when a prop changes. React discards this render and re-runs with the reset value, so the stale
  // elapsed time is never shown and there is no double commit.
  if (anchor !== seenAnchor) {
    setSeenAnchor(anchor);
    setElapsed(0);
  }

  useEffect(() => {
    const start = performance.now();
    const timer = setInterval(() => setElapsed(performance.now() - start), intervalMs);
    return () => clearInterval(timer);
  }, [anchor, intervalMs]);

  return elapsed;
}

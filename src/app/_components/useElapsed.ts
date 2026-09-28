"use client";

import { useEffect, useState } from "react";

/**
 * How many milliseconds have passed since this component's server-time anchor, updated once a
 * second.
 *
 * Both timers in the app are built on this: the hold countdown in Countdown.tsx and the
 * "starts in 25 min" clock in EventTime.tsx. Both work the same way — the server sends the
 * two numbers that matter, and this hook supplies the ticking.
 *
 * THE ANCHOR ARGUMENT
 *
 * `anchor` is the server clock reading the caller is counting from (its `serverNow`). It is
 * passed in for one reason: when it changes, the count must restart from zero.
 *
 * Here is the bug that forces this. A checkout page can re-fetch itself in place — SessionSync
 * does exactly that on a Back navigation or a cross-tab nudge. That hands the countdown a fresh
 * `serverNow`, computed at the moment of the re-fetch. But if this hook kept counting elapsed
 * time from the *original* mount, the caller would subtract that elapsed time from the *new*
 * anchor, counting the gap twice — the timer would jump forward by however long the page had
 * been open. Making `anchor` a dependency of the effect restarts the stopwatch whenever the
 * server sends a new reading, so elapsed time is always measured from the anchor it belongs to.
 *
 * WHY NOT JUST READ THE CLOCK?
 *
 * The obvious version of a countdown reads the current wall-clock time on every tick and
 * subtracts. The problem is that wall-clock time can move underneath you in ways that have
 * nothing to do with time actually passing — most sharply when a phone reconnects and the
 * operating system re-syncs its clock with the network, which can jump it by seconds or minutes.
 * A countdown doing arithmetic on that jumps with it.
 *
 * `performance.now()` avoids all of it. It measures time since the page opened and only ever
 * moves forward at a steady rate — no clock correction, timezone change or daylight-saving
 * switch touches it. It also keeps counting while a tab is in the background, so if the browser
 * throttles our interval and skips ticks, the next tick still reports the true elapsed time
 * instead of drifting behind.
 *
 * Returning 0 on the first render is what keeps server and browser agreeing. The server has no
 * `performance.now()` and never runs the effect below, so it renders the untouched starting
 * value; the browser's first render matches it exactly, and only then does the ticking begin.
 */
export function useElapsed(anchor: number, intervalMs = 1000): number {
  const [elapsed, setElapsed] = useState(0);
  const [seenAnchor, setSeenAnchor] = useState(anchor);

  // A new anchor means the caller's numbers were just refreshed, so the count must restart
  // from zero. This is React's recommended way to reset state when a prop changes: adjust it
  // during render, not in an effect. React discards this render and immediately re-runs with
  // the reset value, so the stale elapsed time is never shown and there is no double commit —
  // which is also why `setElapsed` does not belong inside the effect below.
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

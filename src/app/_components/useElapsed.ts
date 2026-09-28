"use client";

import { useEffect, useState } from "react";

/**
 * HOW MANY MILLISECONDS HAVE PASSED SINCE THIS COMPONENT'S SERVER-TIME ANCHOR
 *
 * Since both timers in the app — the hold countdown in Countdown.tsx and the "starts in 25 min"
 * clock in EventTime.tsx — need to advance once a second while staying correct, they need a
 * single hook that supplies the ticking, and this is it. The division of labour is deliberate:
 * the server sends the two numbers that matter and the caller subtracts them, so the first
 * render is correct on its own; this hook only adds the passage of time on top.
 *
 * THE ANCHOR ARGUMENT
 *
 * `anchor` is the server clock reading the caller is counting from (its `serverNow`). Since a
 * checkout page can re-fetch itself in place — SessionSync does exactly that on a Back
 * navigation or a cross-tab nudge — the caller can be handed a fresh `serverNow` partway
 * through the component's life. When that happens the count must restart from zero, so `anchor`
 * is passed in for the sole reason of being able to detect the change and reset. If it did not,
 * the hook would keep counting elapsed time from the *original* mount while the caller
 * subtracted that elapsed time from the *new* anchor, counting the same gap twice and making
 * the timer jump forward by however long the page had been open.
 *
 * WHY IT MEASURES ELAPSED TIME RATHER THAN READING THE CLOCK
 *
 * The obvious way to build a countdown is to read the current wall-clock time on every tick and
 * subtract. Since wall-clock time can move for reasons that have nothing to do with time
 * passing — most sharply when a phone reconnects and the OS re-syncs its clock, which can jump
 * it by seconds or minutes — a countdown doing arithmetic on it would jump with it. So this
 * measures elapsed time with `performance.now()` instead, for the following reasons: it only
 * ever moves forward at a steady rate, no clock correction or timezone change touches it, and
 * it keeps counting while a tab is backgrounded, so a throttled interval that skips ticks still
 * reports the true elapsed time on its next tick rather than drifting behind.
 *
 * WHY IT RETURNS 0 ON THE FIRST RENDER
 *
 * Since the server has no `performance.now()` and never runs the effect below, it renders the
 * untouched starting value; the browser's first render has to match that exactly or React
 * reports a hydration mismatch. Returning 0 initially is what guarantees the match — the
 * browser's first render agrees with the server's, and only then does the ticking begin.
 */
export function useElapsed(anchor: number, intervalMs = 1000): number {
  const [elapsed, setElapsed] = useState(0);
  const [seenAnchor, setSeenAnchor] = useState(anchor);

  // Since a new anchor means the caller's numbers were just refreshed, the count has to restart
  // from zero, and it is done here during render rather than in the effect below for a specific
  // reason: this is React's recommended way to reset state when a prop changes. React discards
  // this render and immediately re-runs with the reset value, so the stale elapsed time is never
  // shown and there is no double commit — which is also why calling `setElapsed` inside the
  // effect would be the wrong place for it.
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

"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Last resort for an unexpected error while rendering. Every outcome the domain knows about is a
 * status the checkout page renders normally, and an unknown session is a 404, so nothing routine
 * reaches here: this screen means a genuine bug, and says the one thing the fan needs to know, that
 * retrying a page render cannot charge anyone.
 *
 * `retry()` rather than `reset()` because only `retry()` re-fetches the boundary's children;
 * `reset()` re-renders the same data and would fail again.
 */
export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error("checkout render failed", error);
  }, [error]);

  return (
    <main className="web">
      <h1>Something went wrong on our end</h1>
      <p className="muted">
        This is a display problem, not a payment one — loading a page never charges a card. If you were
        mid-checkout, your hold is unchanged and reopening the link shows its real state.
      </p>
      {error.digest && <p className="meta">error {error.digest}</p>}
      <div className="actions">
        <button type="button" onClick={() => retry()}>Try again</button>
        <Link className="button secondary" href="/">Browse events</Link>
      </div>
    </main>
  );
}

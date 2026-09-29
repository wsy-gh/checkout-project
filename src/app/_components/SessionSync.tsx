"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps a checkout page from showing something no longer true. It stores nothing and decides
 * nothing: every branch ends in the same action, ask the server again. Three ways a page goes
 * stale, each with the browser signal that fits it:
 *
 *   Back as a document load. Browsers keep a fully-alive copy of recent pages so Back is instant —
 *   DOM, JS and running timers frozen and thawed — so a fan can pay, press Back, and get the old
 *   page with a running countdown and live Pay button. `no-store` mostly prevents it, but "mostly"
 *   is not a guarantee, so `pageshow` (which reports a thawed page) refetches.
 *
 *   Back within the app. Paying ends in a redirect Next.js handles client-side, so `pageshow` does
 *   not fire. The server would refuse the replayed press on its version, so there is no double
 *   charge, but the fan would see a conflict instead of the confirmation they earned. `popstate`
 *   does fire for this, and covers it.
 *
 *   Two tabs. Each tab announces the version it is showing on a channel named for the session: a
 *   tab hearing a higher number refetches, one hearing a lower number answers with its own so the
 *   other side catches up. One hop either way, and no shared state — only a nudge.
 *
 * Plus a plain poll while a payment is confirming, the one screen with nothing to do but wait.
 */
export function SessionSync({ sessionId, version, pending }: { sessionId: string; version: number; pending: boolean }) {
  const router = useRouter();

  useEffect(() => {
    const refresh = () => router.refresh();

    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) refresh();
    };
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("popstate", refresh);

    const channel = "BroadcastChannel" in window ? new BroadcastChannel(`checkout:${sessionId}`) : null;
    if (channel) {
      channel.onmessage = (e: MessageEvent<unknown>) => {
        if (typeof e.data !== "number") return;
        if (e.data > version) refresh();
        // The one behind spoke first, so answer with ours to make them refetch: converges in one hop.
        else if (e.data < version) channel.postMessage(version);
      };
      channel.postMessage(version);
    }

    const poll = pending ? setInterval(refresh, 2000) : undefined;

    return () => {
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("popstate", refresh);
      channel?.close();
      clearInterval(poll);
    };
  }, [router, sessionId, version, pending]);

  return null;
}

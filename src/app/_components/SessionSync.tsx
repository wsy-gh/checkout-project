"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps a checkout page from showing something that is no longer true.
 *
 * Every branch here ends in the same action: ask the server again. Nothing is stored in the
 * browser and nothing is decided there — this component only ever says "what I am showing
 * may be stale, fetch it fresh". That matters, because the moment a browser starts deciding
 * anything about a checkout you have two sources of truth and no way to tell which is right.
 *
 * Three ways a page goes stale, and none of them overlap:
 *
 *   COMING BACK VIA THE BACK BUTTON (a document load).
 *   Browsers keep a fully-alive copy of recent pages so that Back is instant — the DOM, the
 *   JavaScript, the running timers, all frozen and thawed. Lovely for an article, dangerous
 *   for a checkout: the fan pays, presses Back, and gets the old page complete with a
 *   running countdown and a live Pay button. `Cache-Control: no-store` is supposed to
 *   prevent this and mostly does, but "mostly" is not a guarantee, so the `pageshow` event
 *   tells us when a frozen page has been thawed and we refetch.
 *
 *   COMING BACK VIA THE BACK BUTTON (within the app).
 *   Paying ends in a redirect that Next.js handles inside the browser rather than as a fresh
 *   page load. `pageshow` does not fire for those, so Back from the confirmation to the
 *   pre-payment URL could replay a cached screen with Pay still live. The server would
 *   refuse that press on the version number, so no double charge — but the fan would get a
 *   conflict error instead of the confirmation they had already earned. `popstate` fires for
 *   this kind of navigation and covers it.
 *
 *   TWO TABS ON ONE MACHINE.
 *   Tabs share cookies and local storage, which tempts people into using storage as a lock.
 *   Instead each tab announces the version number it is showing on a channel named after the
 *   session. A tab hearing a higher number than its own knows it is behind and refetches; a
 *   tab hearing a lower one answers with its own so the other side catches up. One round
 *   trip either way, and no state is shared — only a nudge.
 *
 * There is also a plain poll while a payment is being confirmed, because that is the one
 * screen with nothing for the fan to do but wait.
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
        // Whoever is behind spoke first; answer so they refetch too. Converges in one hop.
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

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * KEEPS A CHECKOUT PAGE FROM SHOWING SOMETHING THAT IS NO LONGER TRUE.
 *
 * Since the moment a browser starts deciding anything about a checkout you have two sources of
 * truth and no way to tell which is right, this component needs to store nothing and decide
 * nothing: every branch below ends in the same single action — ask the server again. It only ever
 * says "what I am showing may be stale, fetch it fresh".
 *
 * There are three non-overlapping ways a page goes stale, and it is implemented to cover each with
 * the browser signal that fits it:
 *
 *   COMING BACK VIA THE BACK BUTTON (a document load). Since browsers keep a fully-alive copy of
 *   recent pages so Back is instant — DOM, JavaScript and running timers all frozen and thawed —
 *   the fan can pay, press Back, and get the old page complete with a running countdown and a live
 *   Pay button. `Cache-Control: no-store` is supposed to prevent this and mostly does, but "mostly"
 *   is not a guarantee, so the `pageshow` event (which reports a thawed frozen page) triggers a
 *   refetch.
 *
 *   COMING BACK VIA THE BACK BUTTON (within the app). Since paying ends in a redirect that Next.js
 *   handles inside the browser rather than as a fresh page load, `pageshow` does not fire for it, so
 *   Back from the confirmation to the pre-payment URL could replay a cached screen with Pay still
 *   live. The server would refuse that press on the version number, so there is no double charge,
 *   but the fan would get a conflict error instead of the confirmation they had already earned — so
 *   `popstate`, which does fire for this kind of navigation, covers it.
 *
 *   TWO TABS ON ONE MACHINE. Since tabs share cookies and local storage, which tempts people into
 *   using storage as a lock, this instead has each tab announce the version number it is showing on
 *   a channel named after the session: a tab hearing a higher number than its own knows it is behind
 *   and refetches, and a tab hearing a lower one answers with its own so the other side catches up.
 *   One round trip either way, and no state is shared — only a nudge.
 *
 * There is also a plain poll while a payment is being confirmed, because that is the one screen with
 * nothing for the fan to do but wait.
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
        // Whoever is behind spoke first, so answer with our version to make them refetch too; this
        // converges in a single hop.
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

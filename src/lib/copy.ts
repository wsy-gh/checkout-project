import type { FailReason } from "@/checkout/types";
import { plural, same, type Wording } from "./i18n";

/**
 * EVERY WORD THE FAN READS
 *
 * One file, so translating the app means translating this and nothing else, and so anyone
 * can review the wording without reading JSX. See `i18n.ts` for the rules these follow.
 *
 * Two conventions worth knowing before you read on:
 *
 *   A phrase that differs between surfaces is a `{ web, mobile }` pair. `same("…")` is the
 *   shorthand for the many that don't differ.
 *
 *   A phrase with a value inside it is a *function* taking that value, never a fragment the
 *   caller glues together. `total => \`Accept ${total}\`` can be reordered by a translator;
 *   `"Accept " + total` at the call site cannot.
 *
 * The dev-only session inspector is deliberately not here — it is written for whoever is
 * reviewing this code, not for a fan, and translating it would be effort wasted.
 */
export const copy = {
  /** The checkout screens in src/app/_components/RecoveryState.tsx, one per session status. */
  checkout: {
    seats: (count: number) => `${count} ${plural(count, { one: "ticket", other: "tickets" })}`,

    priceChanged: {
      title: { web: "The price changed while you were away", mobile: "Price changed" },
      // Only the web surface has room to explain; the phone shows the two numbers and trusts
      // the Accept button to make the rest obvious.
      note: { web: ". We won't charge the new price until you accept it.", mobile: "" },
      accept: (newTotal: string) => `Accept ${newTotal}`,
      decline: { web: "No thanks", mobile: "Cancel" },
    },

    confirming: {
      title: { web: "We're confirming your payment", mobile: "Confirming your payment…" },
      body: {
        web: "Don't retry or re-enter your card. This page updates itself — it may be finishing on your other device.",
        mobile: "Don't retry. This page will update.",
      },
      refresh: same("Refresh"),
    },

    completed: {
      title: { web: "Order confirmed", mobile: "You're in." },
      orderLine: (orderId: string, total: string) => `Order ${orderId} · ${total}`,
      done: { web: "Back to events", mobile: "View tickets" },
    },

    expired: {
      title: { web: "Your hold ended while you were away", mobile: "Your hold ended" },
      body: {
        web: "The seats were released so other fans could buy them. You can try again if they're still available.",
        mobile: "Seats were released. Grab them again?",
      },
      retry: same("Try again"),
      back: same("Back"),
    },

    /**
     * Every way a checkout can end badly. Because the type is keyed by `FailReason`, adding
     * a new one in src/checkout/types.ts will not compile until someone writes its wording.
     *
     * All three say what happened to the money, because that is the question a person
     * actually has when a payment screen fails, and leaving it unanswered creates support
     * tickets.
     */
    failed: {
      INVENTORY_WITHDRAWN: {
        title: { web: "These tickets are no longer available", mobile: "No longer available" },
        body: {
          web: "The seller withdrew this listing. Your seats were released and you were not charged.",
          mobile: "The seller pulled this listing.",
        },
        action: { web: "Browse other listings", mobile: "Browse" },
      },
      DECLINED: {
        title: { web: "Your payment didn't go through", mobile: "Payment declined" },
        body: {
          web: "Your seats were released. You can try again with another payment method.",
          mobile: "Your seats were released. Try another card.",
        },
        action: same("Try again"),
      },
      PENDING_TIMEOUT: {
        title: { web: "We couldn't confirm your payment", mobile: "Couldn't confirm payment" },
        body: {
          web: "The payment provider never confirmed. If you were charged, it will be refunded automatically.",
          mobile: "If you were charged, we'll refund it.",
        },
        action: same("Try again"),
      },
    } satisfies Record<FailReason, { title: Wording; body: Wording; action: Wording }>,

    /**
     * Shown when the server turns down something the fan just did — pressing Pay, accepting a
     * new price, or asking for another go at an expired hold. Keyed by the domain's error
     * codes, and covering every code that can reach the banner rather than only the ones from
     * the pay path, because `refusalToShow` in RecoveryState.tsx decides what is worth saying
     * and an uncovered code falls through to a developer-shaped sentence.
     *
     * The bottom three are the re-hold path: the fan's seats went somewhere else while they
     * were away, which is the one refusal that otherwise leaves the screen looking unchanged.
     */
    rejected: {
      STALE_VERSION: "This page was out of date. Here's the current state — please try again.",
      PRICE_CHANGED: "The price changed. Review it below before paying.",
      IN_PROGRESS_ELSEWHERE: "Payment is already in progress on another device.",
      INVALID_REQUEST: "Something about that request didn't look right. Please try again.",
      SOLD_OUT: "Another fan took those seats while you were away. Other listings for this event may still have some.",
      SALES_CLOSED: "Sales have closed for this event, so the hold can't be renewed.",
      INVENTORY_WITHDRAWN: "The seller withdrew this listing, so those seats can't be held again.",
      RATE_LIMITED: "That's a lot of checkouts in a short time. Give it a minute and try again.",
    } as Record<string, string | undefined>,
  },

  /** The listing page, src/app/listing/[id]/page.tsx. */
  listing: {
    seatsLeft: (count: number) => `${count} left`,
    eachFeesIncluded: "each, fees included",
    quantityLabel: "Qty",
    startOnWeb: "Start checkout on web",
    startOnMobile: "Start on mobile",
    soldOut: {
      title: "These seats are gone",
      body: "Someone else finished checkout first. Other listings for this event may still have seats.",
    },
    withdrawn: {
      title: "These tickets are no longer available",
      body: "The seller withdrew this listing.",
    },
    salesClosed: {
      title: "Sales have closed for this event",
      body: "Checkout closes shortly before kickoff, so there is time to get in.",
    },
    browseOthers: "Browse other listings",
    /** Why a checkout could not be started. Keyed by the error codes from `create`. */
    createFailed: {
      SOLD_OUT: "Those seats went while you were deciding. Try a smaller quantity, or another listing.",
      INVENTORY_WITHDRAWN: "This listing was withdrawn.",
      SALES_CLOSED: "Sales have closed for this event.",
      INVALID_REQUEST: "That quantity isn't available.",
      RATE_LIMITED: "You've started a lot of checkouts just now. Give it a minute and try again.",
    } as Record<string, string | undefined>,
  },

  /** The home page, src/app/page.tsx. */
  home: {
    resumeTitle: "You have a hold in progress",
    resumeOnWeb: "Resume on web",
    resumeOnMobile: "Resume on mobile",
    withdrawn: "Withdrawn by the seller",
    unavailable: "unavailable",
    salesClosed: "sales closed",
    soldOut: "sold out",
    buy: "Buy",
  },

  /** Dead ends: src/app/not-found.tsx and the two checkout-specific ones beside it. */
  notFound: {
    page: { title: "Page not found", body: "That link doesn't point anywhere in this app." },
    checkout: {
      title: "We couldn't find that checkout",
      web: "The link may be old or mistyped. Your tickets and payments are unaffected.",
      mobile: "This link may be old. Nothing was charged.",
    },
    browse: "Browse events",
  },

  /** src/app/error.tsx, for the unexpected. */
  error: {
    title: "Something went wrong on our end",
    body: "This is a display problem, not a payment one — loading a page never charges a card. If you were mid-checkout, your hold is unchanged and reopening the link shows its real state.",
    retry: "Try again",
  },

  /** Announced to screen readers, never shown. */
  a11y: {
    opensInNewTab: "(opens in a new tab)",
    holdEnded: "Your hold has ended.",
    thirtySeconds: "30 seconds left.",
    twoMinutes: "2 minutes left on your hold.",
  },
};

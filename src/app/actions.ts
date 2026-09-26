"use server";

import { redirect } from "next/navigation";
import { isCheckoutError, type ErrorCode, type Surface } from "@/checkout/types";
import { checkout } from "@/lib/checkout";

/**
 * HOW THE WEB PAGES TALK TO THE BACKEND
 *
 * These are Server Actions: functions that live on the server but can be handed directly to
 * a form's `action`. The browser then submits that form the ordinary way, and Next.js routes
 * it here. The reason this matters is that ordinary form submission is something browsers
 * have always done without help — so the forms on these pages work from the moment the HTML
 * arrives, before React has loaded and even if it never does.
 *
 * Each function here is a thin wrapper that reads the form fields and calls exactly the same
 * function in src/checkout/service.ts that the HTTP API in src/app/api/sessions/ calls. Two
 * front doors, one set of rules behind them. Nothing is decided in this file.
 *
 * They all finish by redirecting rather than returning data, so the page is re-rendered from
 * the session as it now stands. That keeps what the fan sees tied to the server's state
 * rather than to whatever the last request happened to hand back.
 */

export type ActionState = { code?: ErrorCode; ok?: boolean };

export async function createSession(formData: FormData): Promise<void> {
  const surface = (formData.get("surface") === "mobile" ? "mobile" : "web") as Surface;
  let id: string;
  try {
    id = checkout.create({
      listingId: String(formData.get("listingId")),
      quantity: Number(formData.get("quantity") ?? 1),
      surface,
    }).id;
  } catch (e) {
    if (isCheckoutError(e)) redirect(`/listing/${formData.get("listingId")}?error=${e.code}`);
    throw e;
  }
  redirect(surface === "mobile" ? `/m/checkout/${id}` : `/checkout/${id}`);
}

export async function pay(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = String(formData.get("id"));
  try {
    await checkout.complete(id, {
      version: Number(formData.get("version")),
      priceVersion: Number(formData.get("priceVersion")),
      idempotencyKey: String(formData.get("idempotencyKey")),
      paymentToken: "tok_test", // provider-hosted fields would supply this; the session never stores it
      surface: formData.get("surface") === "mobile" ? "mobile" : "web",
    });
  } catch (e) {
    if (isCheckoutError(e)) return refreshWith({ code: e.code }, formData);
    throw e;
  }
  return refreshWith({ ok: true }, formData);
}

export async function acceptPrice(formData: FormData): Promise<void> {
  const id = String(formData.get("id"));
  let code: ErrorCode | undefined;
  try {
    await checkout.acceptPrice(id, {
      version: Number(formData.get("version")),
      priceVersion: Number(formData.get("priceVersion")),
      surface: formData.get("surface") === "mobile" ? "mobile" : "web",
    });
  } catch (e) {
    if (!isCheckoutError(e)) throw e;
    // The page still re-renders from the truth, but it has to say what was refused as well.
    // Redrawing a screen that looks unchanged and saying nothing is indistinguishable from a
    // button that does not work.
    code = e.code;
  }
  redirect(pathFor(formData) + (code ? `?result=${code}` : "?result=ok"));
}

export async function rehold(formData: FormData): Promise<void> {
  let next;
  try {
    next = checkout.rehold(String(formData.get("id")));
  } catch (e) {
    // Someone else took the seats in the meantime. Re-render the expired session, which
    // already knows how to say so — never an error page.
    if (isCheckoutError(e)) redirect(pathFor(formData) + `?result=${e.code}`);
    throw e;
  }
  redirect(formData.get("surface") === "mobile" ? `/m/checkout/${next.id}` : `/checkout/${next.id}`);
}

/**
 * After a Server Action, re-render the page from the session's true state. A redirect to
 * the same URL is the simplest way to guarantee the RSC tree matches the store, whether
 * the form was submitted with or without JavaScript.
 */
function refreshWith(state: ActionState, formData: FormData): never {
  redirect(pathFor(formData) + (state.code ? `?result=${state.code}` : "?result=ok"));
}

function pathFor(formData: FormData) {
  const id = String(formData.get("id"));
  return formData.get("surface") === "mobile" ? `/m/checkout/${id}` : `/checkout/${id}`;
}

"use server";

import { redirect } from "next/navigation";
import { isCheckoutError, type ErrorCode } from "@/checkout/types";
import { checkout } from "@/lib/checkout";
import { getOrCreateClientId } from "@/lib/client-id";
import { asSurface } from "@/lib/input";
import { checkoutPath } from "@/lib/routes";

/**
 * Server Actions: handed straight to a form's `action`, so the browser submits the form the ordinary
 * way and the forms work from the moment the HTML arrives, before React has loaded.
 *
 * Each is a thin wrapper that reads the form fields and calls the same service function the HTTP API
 * calls — two front doors, one set of rules, nothing decided here. They all finish by redirecting
 * rather than returning data, so the page is rebuilt from the session as it now stands rather than
 * from whatever the last request handed back.
 */

export type ActionState = { code?: ErrorCode; ok?: boolean };

export async function createSession(formData: FormData): Promise<void> {
  const surface = asSurface(formData.get("surface")) ?? "web";
  // Identify the browser, minting the cookie on first use, so repeating Buy → Start → Back resumes
  // this browser's hold instead of reserving new seats.
  const clientId = await getOrCreateClientId();
  let id: string;
  try {
    id = (await checkout.create({
      listingId: String(formData.get("listingId")),
      quantity: Number(formData.get("quantity") ?? 1),
      surface,
      clientId,
    })).id;
  } catch (e) {
    if (isCheckoutError(e)) redirect(`/listing/${formData.get("listingId")}?error=${e.code}`);
    throw e;
  }
  redirect(checkoutPath(id, surface));
}

export async function pay(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = String(formData.get("id"));
  try {
    await checkout.complete(id, {
      version: Number(formData.get("version")),
      priceVersion: Number(formData.get("priceVersion")),
      idempotencyKey: String(formData.get("idempotencyKey")),
      paymentToken: "tok_test", // provider-hosted fields would supply this; the session never stores it
      surface: surfaceOf(formData),
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
      surface: surfaceOf(formData),
    });
  } catch (e) {
    if (!isCheckoutError(e)) throw e;
    // An accepted-price refusal often leaves the screen looking unchanged, so the reason has to
    // travel in `code`: redrawing identically and saying nothing looks like a broken button.
    code = e.code;
  }
  redirect(pathFor(formData, { result: code ?? "ok" }));
}

export async function rehold(formData: FormData): Promise<void> {
  let next;
  try {
    next = await checkout.rehold(String(formData.get("id")));
  } catch (e) {
    // This only fails when someone else took the seats, so re-render the expired session, which
    // already knows how to say so, rather than showing an error page.
    if (isCheckoutError(e)) redirect(pathFor(formData, { result: e.code }));
    throw e;
  }
  redirect(checkoutPath(next.id, surfaceOf(formData)));
}

export async function releaseHold(formData: FormData): Promise<void> {
  let listingId: string;
  try {
    listingId = (await checkout.cancel(String(formData.get("id")))).listingId;
  } catch (e) {
    // Refused because the session already moved on — a charge started, or the hold lapsed on its own
    // — so re-render the checkout page, whose status screen already explains each of those.
    if (isCheckoutError(e)) redirect(pathFor(formData, { result: e.code }));
    throw e;
  }
  // Back to the listing rather than the dead checkout: the seats are on sale again by the time this
  // renders, so the quantity picker offers the full range and starting over is one click.
  redirect(`/listing/${listingId}`);
}

// A redirect back to the same URL is the simplest way to guarantee the rendered tree matches the
// store, whether or not the form was submitted with JavaScript.
function refreshWith(state: ActionState, formData: FormData): never {
  redirect(pathFor(formData, { result: state.code ?? "ok" }));
}

/** The surface a form was submitted from. Checked, not cast — see src/lib/input.ts. */
function surfaceOf(formData: FormData) {
  return asSurface(formData.get("surface")) ?? "web";
}

/** Back to the page this form was on, carrying whatever the server decided. */
function pathFor(formData: FormData, extra: Record<string, string> = {}) {
  return checkoutPath(String(formData.get("id")), surfaceOf(formData), extra);
}

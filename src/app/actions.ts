"use server";

import { redirect } from "next/navigation";
import { isCheckoutError, type ErrorCode, type Surface } from "@/checkout/types";
import { checkout } from "@/lib/checkout";

/**
 * Server Actions: the web surface's transport. Each is a thin adapter over the same
 * domain calls the HTTP API uses. Forms that call these are progressively enhanced —
 * they submit even before hydration — which is what makes "Pay works before JS" true.
 */

export type ActionState = { code?: ErrorCode; ok?: boolean };

export async function createSession(formData: FormData): Promise<void> {
  const surface = (formData.get("surface") === "mobile" ? "mobile" : "web") as Surface;
  let id: string;
  try {
    id = checkout.create({
      listingId: String(formData.get("listingId")),
      quantity: Math.max(1, Number(formData.get("quantity") ?? 1)),
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
  try {
    await checkout.acceptPrice(id, {
      version: Number(formData.get("version")),
      priceVersion: Number(formData.get("priceVersion")),
      surface: formData.get("surface") === "mobile" ? "mobile" : "web",
    });
  } catch (e) {
    if (!isCheckoutError(e)) throw e; // any rejection: the page re-renders from the truth
  }
  redirect(pathFor(formData));
}

export async function rehold(formData: FormData): Promise<void> {
  const next = checkout.rehold(String(formData.get("id")));
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

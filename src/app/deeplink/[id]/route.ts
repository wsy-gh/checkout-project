import { redirect } from "next/navigation";

/**
 * Stands in for the link that would open the native app.
 *
 * In a real product this would be a universal link — tap it on a phone and the app opens on
 * the checkout screen, or the website handles it if the app is not installed. Here it simply
 * redirects to the simulated mobile surface, which is enough to show the part that matters.
 *
 * And the part that matters is what the link contains: an ID, and nothing else. No price, no
 * expiry, no seat details. All of those would be stale by the time anyone tapped it, and a
 * link a stranger could edit is not something to take instructions from. The receiving page
 * asks the server and finds out the truth for itself.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/m/checkout/${id}`);
}

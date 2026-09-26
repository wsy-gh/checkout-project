import { redirect } from "next/navigation";

/**
 * Stands in for the app's deep-link handler. A real `gametime://checkout/:id` universal
 * link would open the app and land on the mobile checkout screen; here it 302s to the
 * simulated mobile route. The link carries only an id — never state.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/m/checkout/${id}`);
}

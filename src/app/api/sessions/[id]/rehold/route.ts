import { checkout } from "@/lib/checkout";
import { respond } from "@/lib/respond";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/sessions/:id/rehold → a fresh session for the same listing (only from EXPIRED). */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return respond(() => checkout.rehold(id));
}

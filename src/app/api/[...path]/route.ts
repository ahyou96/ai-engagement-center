import { handler } from "@/lib/api";
import { dispatch } from "@/lib/router";
import { ensureBackground } from "@/lib/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type P = { params: Promise<{ path: string[] }> };
const go = handler(async (req: Request, ctx: P) => { ensureBackground(); return dispatch(req, (await ctx.params).path.join("/")); });
export const GET = go, POST = go, PUT = go, DELETE = go;

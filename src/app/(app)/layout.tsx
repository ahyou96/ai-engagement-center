import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AppShell } from "@/components/shell";
import { ensureBackground } from "@/lib/scheduler";

export const dynamic = "force-dynamic";
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  ensureBackground();
  const u = await currentUser();
  if (!u) redirect("/login");
  return <AppShell>{children}</AppShell>;
}

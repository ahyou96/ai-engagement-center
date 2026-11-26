"use client";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { CopilotPage } from "@/components/copilot";
function Inner() { const sp = useSearchParams(); return <CopilotPage initial={sp.get("c")} />; }
export default function Page() { return <Suspense><Inner /></Suspense>; }

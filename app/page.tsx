import { redirect } from "next/navigation";
import { auth } from "@/auth";
import HomeLanding from "@/components/app/home/HomeLanding";
import type { AuthMode } from "@/components/app/auth/AuthModal";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ auth?: string; next?: string }>;
}) {
  const session = await auth();
  if (session?.user) {
    redirect("/dashboard");
  }

  const params = await searchParams;
  const authMode: AuthMode | null =
    params.auth === "login" ? "login" : params.auth === "signup" ? "signup" : null;
  const nextPath = typeof params.next === "string" ? params.next : null;

  return <HomeLanding initialAuth={authMode} nextPath={nextPath} />;
}

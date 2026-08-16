import { redirect } from "next/navigation";
import { loginModalHref } from "@/lib/auth/public-login";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  redirect(loginModalHref(typeof params.next === "string" ? params.next : null));
}

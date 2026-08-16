import { redirect } from "next/navigation";
import { signupModalHref } from "@/lib/auth/public-login";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  redirect(signupModalHref(typeof params.next === "string" ? params.next : null));
}

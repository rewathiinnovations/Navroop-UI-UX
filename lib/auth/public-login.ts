export function safeNextPath(value: string | null | undefined) {
  if (!value) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}

export function loginModalHref(next?: string | null) {
  const params = new URLSearchParams({ auth: "login" });
  const safe = safeNextPath(next);
  if (safe) params.set("next", safe);
  return `/?${params.toString()}`;
}

export function signupModalHref(next?: string | null) {
  const params = new URLSearchParams({ auth: "signup" });
  const safe = safeNextPath(next);
  if (safe) params.set("next", safe);
  return `/?${params.toString()}`;
}

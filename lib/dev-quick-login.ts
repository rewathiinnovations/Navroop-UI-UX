/** Client-safe: buttons only render outside production. */
export function isDevQuickLoginEnabled() {
  if (process.env.NODE_ENV === "production") return false;
  return (
    process.env.NODE_ENV === "development" ||
    process.env.NEXT_PUBLIC_DEV_QUICK_LOGIN === "true"
  );
}

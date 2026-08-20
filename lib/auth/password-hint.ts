/**
 * The live hint under a new-password field. Shared by the reset form and the invite accept
 * form so the two screens cannot drift into telling people different things about the same
 * rule — `validatePassword` in `lib/password.ts` is the rule, 8 characters, and this is the
 * only place that phrases it for a human.
 */
export function passwordStrengthHint(password: string) {
  if (!password) return 'At least 8 characters';
  if (password.length < 8) return `${password.length}/8 so far — a bit longer`;
  if (password.length < 12) return 'Good — 12+ characters is even better';
  return 'Strong password';
}

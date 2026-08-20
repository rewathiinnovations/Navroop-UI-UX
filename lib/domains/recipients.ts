/**
 * Who is told a custom domain failed (F-263).
 *
 * `notifyDomainFailed` emailed every active ADMIN and nobody else, so the person who added
 * the hostname — the only one who can change a record at their registrar — heard nothing
 * seven days after adding it. `CustomDomain` records no `createdById`; the two people the
 * schema does name for a domain are its deployment's publisher and its project's owner.
 *
 * The owner leads because the mail asks for an action only they can take. Deduplication is
 * the point of the second half: the common case is one person who owns the project,
 * published it and holds ADMIN, and three copies of one failure is how a notification stops
 * being read.
 *
 * Pure so the selection is testable without a database — the loading lives in `./notify`.
 */
export function domainFailureRecipients(input: {
  ownerEmail?: string | null;
  publisherEmail?: string | null;
  adminEmails: Array<string | null | undefined>;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [input.ownerEmail, input.publisherEmail, ...input.adminEmails]) {
    const address = candidate?.trim();
    if (!address) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

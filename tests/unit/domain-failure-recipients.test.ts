import { describe, expect, it } from 'vitest';
import { domainFailureRecipients } from '@/lib/domains/recipients';

/**
 * Who is told a custom domain failed (F-263).
 *
 * `notifyDomainFailed` emailed every active ADMIN and nobody else. The person who added the
 * hostname — and the only person who can go and fix the DNS at their registrar — heard
 * nothing, seven days after adding it. `CustomDomain` records no `createdById`, so the two
 * people the schema does name are the deployment's publisher and the project's owner; both
 * are notified alongside the admins.
 *
 * The owner leads the list because the mail asks for an action only they can take. Duplicates
 * must collapse: the common case is one person who owns the project, published it and is an
 * admin, and three copies of the same failure is how a notification gets filtered.
 */

describe('domainFailureRecipients', () => {
  it('includes the project owner, who is the person able to fix the DNS', () => {
    expect(
      domainFailureRecipients({
        ownerEmail: 'owner@example.test',
        publisherEmail: null,
        adminEmails: ['admin@example.test'],
      }),
    ).toContain('owner@example.test');
  });

  it('puts the owner first and keeps the admins', () => {
    expect(
      domainFailureRecipients({
        ownerEmail: 'owner@example.test',
        publisherEmail: 'publisher@example.test',
        adminEmails: ['admin@example.test'],
      }),
    ).toEqual(['owner@example.test', 'publisher@example.test', 'admin@example.test']);
  });

  it('sends one copy when the owner is also the publisher and an admin', () => {
    expect(
      domainFailureRecipients({
        ownerEmail: 'solo@example.test',
        publisherEmail: 'solo@example.test',
        adminEmails: ['solo@example.test'],
      }),
    ).toEqual(['solo@example.test']);
  });

  it('treats addresses differing only in case as the same person', () => {
    expect(
      domainFailureRecipients({
        ownerEmail: 'Owner@Example.test',
        publisherEmail: 'owner@example.test',
        adminEmails: [],
      }),
    ).toEqual(['Owner@Example.test']);
  });

  it('drops blank and missing addresses rather than attempting a send', () => {
    expect(
      domainFailureRecipients({
        ownerEmail: '  ',
        publisherEmail: null,
        adminEmails: [null, undefined, '', 'admin@example.test'],
      }),
    ).toEqual(['admin@example.test']);
  });

  it('still notifies the admins when the project has no reachable owner', () => {
    expect(
      domainFailureRecipients({
        ownerEmail: null,
        publisherEmail: null,
        adminEmails: ['a@example.test', 'b@example.test'],
      }),
    ).toEqual(['a@example.test', 'b@example.test']);
  });

  it('returns nothing rather than an empty send when nobody is reachable', () => {
    expect(
      domainFailureRecipients({ ownerEmail: null, publisherEmail: null, adminEmails: [] }),
    ).toEqual([]);
  });
});

import LegalDraftBanner from '@/components/legal/LegalDraftBanner';

export const metadata = { title: 'Terms of Service — Navroop' };

export default function TermsPage() {
  return (
    <article className="space-y-20 text-[15px] leading-6 text-[var(--studio-fg)]">
      {/* DRAFT — lawyer review required before public launch. Do not present as legally sufficient. */}
      <LegalDraftBanner />
      <div>
        <h1 className="text-[32px] font-medium tracking-[-0.03em]">Terms of Service</h1>
        <p className="mt-8 text-[13px] text-[var(--studio-muted)]">Draft dated 17 August 2026. Version 2026-08-17.</p>
      </div>

      <section className="space-y-8">
        <h2 className="text-[18px] font-medium">What Navroop does</h2>
        <p>
          Navroop is an invite-only studio that helps a workspace generate, edit, preview, and
          publish websites from written prompts. Accounts are created by an administrator invite
          or by the registration form when it is enabled. Generated sites are tools for your
          clients; they are not branded as Navroop.
        </p>
      </section>

      <section className="space-y-8">
        <h2 className="text-[18px] font-medium">Your responsibility for generated sites</h2>
        <p>
          You are responsible for the websites you generate and publish: their content, claims,
          accessibility, licences, trademarks, and any legal notices they must carry. Navroop
          does not review generated copy for accuracy or compliance. If a published site harms
          someone or infringes a right, that is your responsibility, not Navroop’s.
        </p>
      </section>

      <section className="space-y-8">
        <h2 className="text-[18px] font-medium">Acceptable use</h2>
        <p>
          Do not use Navroop to generate or publish malware, phishing, child sexual abuse
          material, or content that is illegal in India. Do not attempt to break into other
          accounts, scrape private systems, or overload the service. We may suspend an account
          that breaks these rules.
        </p>
      </section>

      <section className="space-y-8">
        <h2 className="text-[18px] font-medium">Accounts and access</h2>
        <p>
          Access is limited to invited members of the workspace. You must keep your password
          confidential. Administrators can invite members, assign plans, and request a password
          reset on your behalf.
        </p>
      </section>

      <section className="space-y-8">
        <h2 className="text-[18px] font-medium">Credits, plans, and exports</h2>
        <p>
          Generation, image work, URL import, and some audits consume plan credits. Downloading
          a project as a ZIP does not consume credits. Publishing uses a live or preview slot,
          not credits. Unused credits reset on the plan’s billing period.
        </p>
      </section>

      <section className="space-y-8">
        <h2 className="text-[18px] font-medium">How to request deletion</h2>
        <p>
          Use <strong>Request data export or deletion</strong> on Settings → Profile. That emails
          the workspace administrators. Deletion is not automatic. Soft-deleted projects are
          purged after 30 days (<code>PURGE_DELETED_DAYS</code>).
        </p>
      </section>

      <section className="space-y-8">
        <h2 className="text-[18px] font-medium">Changes</h2>
        <p>
          We may update these terms. The version accepted at registration is stored on your
          account. This draft is not a substitute for a lawyer-reviewed contract.
        </p>
      </section>
    </article>
  );
}

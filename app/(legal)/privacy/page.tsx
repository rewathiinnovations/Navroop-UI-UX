import LegalDraftBanner from '@/components/legal/LegalDraftBanner';

export const metadata = { title: 'Privacy Policy — Navroop' };

export default function PrivacyPage() {
  return (
    <article className="space-y-20 text-[15px] leading-6 text-[var(--studio-fg)]">
      {/* DRAFT — lawyer review required before public launch. Do not present as legally sufficient. */}
      <LegalDraftBanner />
      <div>
        <h1 className="text-[32px] font-medium tracking-[-0.03em]">Privacy Policy</h1>
        <p className="mt-8 text-[13px] text-[var(--studio-muted)]">
          Draft dated 17 August 2026. Version 2026-08-17. Written with India’s Digital Personal
          Data Protection Act, 2023 in mind — still a draft, not legal advice.
        </p>
      </div>

      <section className="space-y-8">
        <h2 className="text-[18px] font-medium">What we store</h2>
        <p>Navroop stores the data needed to run the studio:</p>
        <ul className="list-disc space-y-4 pl-20">
          <li>Account details: name, email, password hash, role, avatar, and terms acceptance time.</li>
          <li>Prompts you type, project names, plans, chat history, and generation events.</li>
          <li>Generated code in checkpoints (object snapshots) and, while a sandbox is live, a temporary VM.</li>
          <li>Published sites: deploy records, DNS hostnames, and custom domains you attach.</li>
          <li>Optional connectors: GitHub App installation, Cloudflare zone, Coolify servers (secrets encrypted).</li>
        </ul>
      </section>

      <section className="space-y-8">
        <h2 className="text-[18px] font-medium">Where it is stored</h2>
        <p>
          Application data lives in the workspace Postgres database. File snapshots and images
          use the configured object store (local disk in development, or the ElasticLake /
          S3-compatible bucket in production). Database backups go to a separate backup bucket,
          not the live asset bucket.
        </p>
      </section>

      <section className="space-y-8">
        <h2 className="text-[18px] font-medium">Third-party processors</h2>
        <p>Depending on configuration, these processors may see data you submit:</p>
        <ul className="list-disc space-y-4 pl-20">
          <li>The model provider used for generation (prompts and selected project files).</li>
          <li>Firecrawl, when you search or import a public URL.</li>
          <li>The object-storage provider for snapshots, assets, and backups.</li>
          <li>Coolify, to build and host preview and live sites.</li>
          <li>Cloudflare, for DNS and custom hostnames.</li>
          <li>Sentry, when error tracking is enabled (request metadata; secrets are scrubbed).</li>
          <li>Resend, when transactional email is enabled (password reset and admin notices).</li>
        </ul>
      </section>

      <section className="space-y-8">
        <h2 className="text-[18px] font-medium">Retention</h2>
        <ul className="list-disc space-y-4 pl-20">
          <li>Idle sandboxes are reaped after 5 minutes (<code>SANDBOX_IDLE_MINUTES</code>). Viewing a site uses a static preview and does not keep a sandbox on.</li>
          <li>Unbookmarked checkpoints are thinned after 7 days (<code>CHECKPOINT_RETENTION_DAYS</code>).</li>
          <li>Soft-deleted projects are purged after 30 days (<code>PURGE_DELETED_DAYS</code>).</li>
          <li>Database backups run daily at 02:00; storage verification runs weekly.</li>
          <li>Password-reset tokens expire in 60 minutes and are stored only as a hash.</li>
        </ul>
      </section>

      <section className="space-y-8">
        <h2 className="text-[18px] font-medium">Your requests</h2>
        <p>
          You can ask for a copy of your data or for deletion from Settings → Profile. The
          request is emailed to workspace administrators. Navroop does not delete an account
          automatically. Administrators should confirm identity before acting.
        </p>
      </section>
    </article>
  );
}

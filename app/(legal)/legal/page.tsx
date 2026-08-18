import Link from 'next/link';
import LegalDraftBanner from '@/components/legal/LegalDraftBanner';

export const metadata = { title: 'Legal — Navroop' };

export default function LegalIndexPage() {
  return (
    <article className="space-y-16">
      <LegalDraftBanner />
      <h1 className="text-[32px] font-medium tracking-[-0.03em]">Legal</h1>
      <p className="text-[15px] leading-6 text-[var(--studio-muted)]">
        These pages are a first draft for Navroop. They are not legal advice and are not
        sufficient for public launch until a lawyer reviews them.
      </p>
      <ul className="space-y-8 text-[15px]">
        <li>
          <Link href="/terms" className="font-medium text-[var(--studio-accent)] hover:underline">
            Terms of Service
          </Link>
        </li>
        <li>
          <Link href="/privacy" className="font-medium text-[var(--studio-accent)] hover:underline">
            Privacy Policy
          </Link>
        </li>
      </ul>
    </article>
  );
}

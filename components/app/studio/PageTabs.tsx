import Link from "next/link";
import { cn } from "@/utils/cn";

export default function PageTabs({
  items,
}: {
  items: Array<{ href: string; label: string; active?: boolean }>;
}) {
  return (
    <nav className="mb-28 flex flex-wrap gap-4 border-b border-[var(--studio-line)]">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={cn(
            "inline-flex min-h-[44px] items-center px-8 text-[14px] transition-colors duration-200",
            item.active
              ? "border-b-2 border-[var(--studio-fg)] text-[var(--studio-fg)]"
              : "text-[var(--studio-muted)] hover:text-[var(--studio-fg)]",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

import { ReactNode } from "react";
import { cn } from "@/utils/cn";
import StudioLogo from "./StudioLogo";
import ThemeToggle from "./ThemeToggle";
import "./studio.css";

type StudioShellProps = {
  children: ReactNode;
  variant?: "auth" | "workspace";
  logoHref?: string;
  contentClassName?: string;
  onNewProject?: () => void;
  newProjectHref?: string;
};

export default function StudioShell({
  children,
  variant = "workspace",
  logoHref = "/dashboard",
  contentClassName,
}: StudioShellProps) {
  if (variant === "workspace") {
    return (
      <div className={cn("relative z-10", contentClassName)}>
        {children}
      </div>
    );
  }

  return (
    <div className="studio-shell relative min-h-screen overflow-hidden">
      <div className="studio-glow" aria-hidden />

      <div className="absolute right-16 top-16 z-20 sm:right-20 sm:top-20">
        <ThemeToggle />
      </div>

      <div
        className={cn(
          "relative z-10 flex min-h-screen flex-col items-center justify-center px-20 py-48",
          contentClassName,
        )}
      >
        <StudioLogo href={logoHref} className="mb-28 justify-center" />
        {children}
      </div>
    </div>
  );
}

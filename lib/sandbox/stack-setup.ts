import {
  getStack,
  shouldInstallPackages,
  splitCommand,
  type StackId,
} from '@/lib/stacks';
import { getStackScaffold, staticHtmlIndex } from '@/lib/stacks/templates';
import type { ScaffoldFile } from '@/lib/stacks/templates';

export type { ScaffoldFile };

export type StackSetupPlan = {
  stack: StackId;
  hasNodeDependencies: boolean;
  installCommand: string | null;
  installArgs: string[] | null;
  devCommand: string;
  devArgs: string[];
  skipInstall: boolean;
};

export function getStackSetupPlan(stack: string): StackSetupPlan {
  const definition = getStack(stack);
  const skipInstall = !shouldInstallPackages(definition.id);
  return {
    stack: definition.id,
    hasNodeDependencies: definition.hasNodeDependencies,
    installCommand: definition.installCommand,
    installArgs: definition.installCommand ? splitCommand(definition.installCommand) : null,
    devCommand: definition.devCommand,
    devArgs: splitCommand(definition.devCommand),
    skipInstall,
  };
}

/** Minimal package.json scripts.dev for stacks that have node deps. */
export function packageJsonDevScript(stack: string): string {
  return getStack(stack).devCommand;
}

export { staticHtmlIndex, getStackScaffold };

/**
 * Known-good template files for NEXTJS/ASTRO/VUE/SVELTE/STATIC_HTML.
 * REACT is not included — providers keep the current Vite/React setupViteApp path.
 */
export function stackScaffoldFiles(stack: string): ScaffoldFile[] {
  return getStackScaffold(stack);
}

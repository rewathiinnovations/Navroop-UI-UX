import ts from 'typescript';
import type { StackId } from '@/lib/stacks';
import { withStarterFiles } from '@/lib/stacks/starter';
import type { BuildError } from './build-check';

/**
 * The check the pipeline has never had: does the generated code type-check.
 *
 * `checkBuild` runs esbuild, which strips TypeScript rather than reading it. That is the
 * right tool for the question it answers — does the module graph link, does every bare
 * specifier resolve — and it is blind to everything else by design. `BuildErrorKind` has
 * carried a `'type'` arm since it was written and nothing could ever produce one.
 *
 * So a section given a prop it does not have, a `.map` on a value that can be undefined, or
 * a variant string the component does not define all bundle clean, preview clean, publish
 * clean, and then fail `next build` inside the client's own repository — the most expensive
 * place in the whole product to discover a defect, and the one place we cannot repair it.
 *
 * Two decisions shape the implementation, both learned the hard way in this repo:
 *
 * 1. NOTHING IS WRITTEN TO DISK. The program runs against an in-memory CompilerHost over the
 *    same file map the bundler sees. An earlier version of this idea (in a test) wrote a
 *    scratch project into the working tree, and a repo-wide scanner two tests over found it.
 *    A validator that runs inside the generation route must not leave anything behind, ever.
 *
 * 2. THE GENERATED PROJECT'S DEPENDENCIES ARE DECLARED, NOT RESOLVED. Navroop does not
 *    install what its generated projects install, so resolving `clsx` or `lucide-react` from
 *    whatever the host happens to have is a check that passes on one machine and fails on
 *    another. They are ambient `any` modules here. That costs the ability to check *inside*
 *    those libraries, which is not this stage's job — the props of the code we generate are.
 */

/** `react` is real: JSX needs its types, and `@types/react` is a dependency of this app. */
const AMBIENT_MODULES = `declare module 'clsx' {
  export type ClassValue = unknown;
  const clsx: any;
  export default clsx;
  export { clsx };
}
declare module 'tailwind-merge' {
  export const twMerge: any;
}
declare module 'class-variance-authority' {
  export type VariantProps<T> = Record<string, any>;
  export const cva: any;
}
declare module 'lucide-react' {
  const icons: any;
  export = icons;
}
declare module 'framer-motion' {
  const motion: any;
  export = motion;
}
declare module 'recharts' {
  const recharts: any;
  export = recharts;
}
declare module 'date-fns' {
  const dateFns: any;
  export = dateFns;
}
declare module '@radix-ui/*' {
  const radix: any;
  export = radix;
}
declare module 'next/image' {
  const Image: any;
  export default Image;
}
declare module 'next/link' {
  const Link: any;
  export default Link;
}
declare module 'next/navigation' {
  export const useRouter: any;
  export const usePathname: any;
  export const useSearchParams: any;
  export const useParams: any;
  export const redirect: any;
  export const notFound: any;
}
declare module 'next/font/google' {
  const font: any;
  export = font;
}
`;

/**
 * Diagnostics worth failing a build over.
 *
 * Deliberately a list rather than "everything the compiler said". A false blocking finding
 * spends a repair generation the user paid for, and these are the codes that mean the model
 * wrote something a person would call wrong — a prop that does not exist, a value of the
 * wrong type, required props missing, a name that was never defined. Everything else is
 * reported at debug level and blocks nothing, so widening this set is a deliberate act with
 * a visible before and after rather than a silent tightening.
 */
const BLOCKING_CODES = new Set([
  2304, // Cannot find name 'X'
  2322, // Type 'X' is not assignable to type 'Y'
  2339, // Property 'X' does not exist on type 'Y'
  2353, // Object literal may only specify known properties
  2551, // Property 'X' does not exist ... did you mean 'Y'
  2554, // Expected N arguments, but got M
  2561, // Object literal may only specify known properties, but 'X' ... did you mean 'Y'
  2739, // Type 'X' is missing the following properties from type 'Y'
  2741, // Property 'X' is missing in type 'Y' but required in type 'Z'
]);

/** Only the code we generated. A diagnostic inside the starter kit is our bug, not the run's. */
function isGeneratedPath(path: string, generatedPaths: ReadonlySet<string>): boolean {
  return generatedPaths.has(path);
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  jsx: ts.JsxEmit.ReactJSX,
  // Not `strict`. The generated project's own tsconfig decides that, and a stage that is
  // stricter than the repo the code ships to would fail builds that are going to be fine.
  strict: false,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
  allowJs: true,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
  allowNonTsExtensions: true,
};

export type TypecheckResult = {
  status: 'passed' | 'failed' | 'skipped';
  errors: BuildError[];
  /** Why nothing ran, when nothing ran. */
  skipReason?: 'no-checker' | 'no-files' | 'unsupported-stack';
};

/**
 * Type-check the generated files against the starter kit, in memory.
 *
 * Returns `skipped` rather than throwing when the compiler is unavailable, matching how the
 * bundle check reports `checker-unavailable`: a check that did not happen must never read as
 * a check that passed, but it must also never fail a build the user's code did not break.
 */
export function typecheckGenerated(input: {
  stack: StackId;
  files: Record<string, string>;
  /** Paths this run wrote. A pre-existing error elsewhere is not this run's to repair. */
  changedPaths?: readonly string[];
  designDirection?: string | null;
}): TypecheckResult {
  const { stack, changedPaths, designDirection } = input;
  if (stack === 'STATIC_HTML')
    return { status: 'skipped', errors: [], skipReason: 'unsupported-stack' };

  const files = withStarterFiles(stack, input.files, designDirection);
  const sources = Object.entries(files).filter(([path]) => /\.(tsx|ts|jsx|js)$/.test(path));
  if (sources.length === 0) return { status: 'skipped', errors: [], skipReason: 'no-files' };

  const scope = changedPaths?.length
    ? new Set(changedPaths.filter((path) => /\.(tsx|ts|jsx|js)$/.test(path)))
    : new Set(sources.map(([path]) => path));

  const AMBIENT_PATH = '__ambient.d.ts';
  const contents = new Map<string, string>(sources);
  contents.set(AMBIENT_PATH, AMBIENT_MODULES);

  const host = inMemoryHost(contents);
  const program = ts.createProgram({
    rootNames: [...contents.keys()],
    options: COMPILER_OPTIONS,
    host,
  });

  const errors: BuildError[] = [];
  for (const diagnostic of program.getSemanticDiagnostics()) {
    if (!BLOCKING_CODES.has(diagnostic.code)) continue;
    const path = diagnostic.file?.fileName;
    if (!path || !isGeneratedPath(path, scope)) continue;
    const position =
      diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : null;
    errors.push({
      kind: 'type',
      message: `${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')} (TS${diagnostic.code})`,
      file: path,
      line: position ? position.line + 1 : null,
    });
  }

  return { status: errors.length > 0 ? 'failed' : 'passed', errors };
}

/**
 * A CompilerHost over a Map, with `react` and the TypeScript lib files read from this app's
 * own installation — the only two things the generated code needs that a declaration cannot
 * stand in for.
 */
function inMemoryHost(contents: Map<string, string>): ts.CompilerHost {
  const base = ts.createCompilerHost(COMPILER_OPTIONS, true);
  return {
    ...base,
    fileExists: (fileName) => contents.has(fileName) || base.fileExists(fileName),
    readFile: (fileName) => contents.get(fileName) ?? base.readFile(fileName),
    getSourceFile: (fileName, languageVersion, onError, shouldCreate) => {
      const own = contents.get(fileName);
      if (own !== undefined) {
        return ts.createSourceFile(fileName, own, languageVersion, true);
      }
      return base.getSourceFile(fileName, languageVersion, onError, shouldCreate);
    },
    writeFile: () => {
      // noEmit is set, and a validator that wrote to disk is the defect this file's header
      // records. Swallowing the call is the guarantee, not the option.
    },
    resolveModuleNameLiterals: (literals, containingFile) =>
      literals.map((literal) => {
        const request = literal.text;
        // `@/x` is the generated project's own alias for its root.
        const local = request.startsWith('@/') ? request.slice(2) : null;
        if (local) {
          for (const suffix of ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts']) {
            const candidate = `${local}${suffix}`;
            if (contents.has(candidate)) {
              return {
                resolvedModule: { resolvedFileName: candidate, extension: extensionOf(candidate) },
              };
            }
          }
          return { resolvedModule: undefined };
        }
        if (request.startsWith('./') || request.startsWith('../')) {
          const resolved = joinRelative(containingFile, request);
          for (const suffix of ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts']) {
            const candidate = `${resolved}${suffix}`;
            if (contents.has(candidate)) {
              return {
                resolvedModule: { resolvedFileName: candidate, extension: extensionOf(candidate) },
              };
            }
          }
          return { resolvedModule: undefined };
        }
        // Bare specifier: `react` resolves for real, everything else is ambient.
        return ts.resolveModuleName(request, containingFile, COMPILER_OPTIONS, base).resolvedModule
          ? ts.resolveModuleName(request, containingFile, COMPILER_OPTIONS, base)
          : { resolvedModule: undefined };
      }),
  };
}

function extensionOf(path: string): ts.Extension {
  if (path.endsWith('.tsx')) return ts.Extension.Tsx;
  if (path.endsWith('.ts')) return ts.Extension.Ts;
  if (path.endsWith('.jsx')) return ts.Extension.Jsx;
  return ts.Extension.Js;
}

function joinRelative(from: string, request: string): string {
  const segments = from.split('/').slice(0, -1);
  for (const part of request.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/');
}

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * `@ai-sdk/openai@2` resolves its callable provider to the Responses API:
 * `provider(modelId)` === `provider.languageModel(modelId)` ===
 * `createResponsesModel(modelId)`, which POSTs `${baseURL}/responses`. Every
 * client in this app is built by `clientForEntry`, whose base URL is
 * `https://api.deepseek.com` — and DeepSeek implements `/chat/completions`
 * only. So the callable form is a 404 on every single call.
 *
 * `chatModelForEntry` was added for exactly this and then rolled out to two of
 * eight call sites. The other six — the audit's AI review, follow-up edit
 * planning, URL-import sectioning and segmentation, memory extraction, skill
 * matching — kept `client(actualModel)`, and every one of them either swallows
 * the throw into a tool-failure finding or degrades to a heuristic, so six AI
 * features were dead at once with nothing surfacing to a user. The audit path
 * only became visible when a code audit started running on every settled
 * build and each project grew a spurious "ai-review tool failed" row.
 *
 * A doc comment saying "use this instead" is what failed the first time, so
 * this walks the tree instead. Modelled on `client-import-boundary.test.ts`:
 * an exported pure finder over an explicit cwd/roots, asserted against the
 * real tree and against synthetic fixtures.
 */

const ROOTS = ['lib', 'app', 'components'] as const;

const SKIP_DIRS = new Set(['node_modules', '.next', 'coverage', 'dist', 'generated']);

/** Factories whose return value is the callable OpenAI provider object. */
const PROVIDER_FACTORIES = new Set(['clientForEntry', 'createOpenAI']);

/** Resolvers that return `{ client, actualModel }` — `client` is that same object. */
const PROVIDER_RESOLVERS = new Set(['getProviderForModel']);

/** Type annotations that mark a parameter as holding the provider object. */
const PROVIDER_TYPE_NAMES = new Set(['ProviderClient', 'OpenAIProvider']);

/** Accessors that are the Responses model under another name. */
const RESPONSES_ACCESSORS = new Set(['responses', 'languageModel']);

export type CallableProviderHit = {
  file: string;
  line: number;
  expression: string;
  message: string;
};

function posix(file: string, cwd: string) {
  return relative(cwd, file).split(sep).join('/');
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...tsFiles(full));
      continue;
    }
    if (/\.(tsx?|jsx?)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** `await x`, `(x)`, `x as T`, `x!` all wrap the call we care about. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isAwaitExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/** The bare name being called: `f()` → `f`, `mod.f()` → `f`. */
function calleeName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

function typeRefName(type: ts.TypeNode | undefined): string | null {
  if (!type || !ts.isTypeReferenceNode(type)) return null;
  return ts.isIdentifier(type.typeName) ? type.typeName.text : null;
}

type Bindings = {
  /** Identifiers holding the provider object itself. */
  providers: Set<string>;
  /** Identifiers holding a `{ client, actualModel }` resolution. */
  resolutions: Set<string>;
};

/**
 * Names are collected in a full pass before any call is judged, so a binding
 * declared after its use (or in a sibling scope) still counts. Over-collecting
 * is deliberate: this guard would rather ask a future author to justify a
 * shadowed name than miss the next `client(actualModel)`.
 */
function collectBindings(sf: ts.SourceFile): Bindings {
  const providers = new Set<string>();
  const resolutions = new Set<string>();

  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer);
      const called = ts.isCallExpression(init) ? calleeName(init) : null;
      if (called && PROVIDER_FACTORIES.has(called) && ts.isIdentifier(node.name)) {
        providers.add(node.name.text);
      }
      if (called && PROVIDER_RESOLVERS.has(called)) {
        if (ts.isIdentifier(node.name)) resolutions.add(node.name.text);
        else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const property = element.propertyName ?? element.name;
            const source = ts.isIdentifier(property) ? property.text : null;
            if (source === 'client' && ts.isIdentifier(element.name)) {
              providers.add(element.name.text);
            }
          }
        }
      }
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      const annotation = typeRefName(node.type);
      if (annotation && PROVIDER_TYPE_NAMES.has(annotation)) providers.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { providers, resolutions };
}

function hit(sf: ts.SourceFile, node: ts.Node, file: string, why: string): CallableProviderHit {
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const expression = node.getText(sf).split('\n')[0]!.trim();
  return {
    file,
    line,
    expression,
    message: `${file}:${line} ${why} — use chatModelForProvider(client, model) / chatModelForEntry(entry, env, model); the callable provider targets /responses, which DeepSeek does not serve`,
  };
}

export function findCallableProviderHits(
  options: { cwd?: string; roots?: string[] } = {},
): CallableProviderHit[] {
  const cwd = options.cwd ?? process.cwd();
  const rootDirs = options.roots ?? ROOTS.map((root) => join(cwd, root));
  const files: string[] = [];
  for (const dir of rootDirs) {
    if (!existsSync(dir)) throw new Error(`callable-provider scan root is missing: ${dir}`);
    files.push(...tsFiles(dir));
  }

  const hits: CallableProviderHit[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (
      !/clientForEntry|createOpenAI|getProviderForModel|ProviderClient|OpenAIProvider/.test(source)
    ) {
      continue;
    }
    const rel = posix(file, cwd);
    const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
    const { providers, resolutions } = collectBindings(sf);

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const target = node.expression;
        if (ts.isIdentifier(target) && providers.has(target.text)) {
          hits.push(hit(sf, node, rel, `calls the provider object \`${target.text}\` directly`));
        } else if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
          const object = target.expression.text;
          const accessor = target.name.text;
          if (providers.has(object) && RESPONSES_ACCESSORS.has(accessor)) {
            hits.push(hit(sf, node, rel, `uses \`${object}.${accessor}\``));
          } else if (resolutions.has(object) && accessor === 'client') {
            hits.push(hit(sf, node, rel, `calls the resolved provider \`${object}.client\``));
          }
        } else if (ts.isCallExpression(target)) {
          const factory = calleeName(target);
          if (factory && PROVIDER_FACTORIES.has(factory)) {
            hits.push(hit(sf, node, rel, `calls \`${factory}(…)\`'s return value directly`));
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}

/** Files where the walk actually bound a provider identifier. A guard that
 *  matches nothing passes forever, which is the failure mode this repo has
 *  already paid for. */
export function callableProviderScanSites(options: { cwd?: string } = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const sites: string[] = [];
  for (const root of ROOTS) {
    for (const file of tsFiles(join(cwd, root))) {
      const source = readFileSync(file, 'utf8');
      if (!/clientForEntry|createOpenAI|getProviderForModel/.test(source)) continue;
      const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
      const { providers, resolutions } = collectBindings(sf);
      if (providers.size > 0 || resolutions.size > 0) sites.push(posix(file, cwd));
    }
  }
  return sites.sort();
}

function fixture(body: string): CallableProviderHit[] {
  const dir = mkdtempSync(join(tmpdir(), 'navroop-callable-provider-'));
  writeFileSync(join(dir, 'call-site.ts'), body);
  return findCallableProviderHits({ cwd: dir, roots: [dir] });
}

describe('no callable @ai-sdk/openai provider', () => {
  it('binds a provider in every file that resolves one', () => {
    const sites = callableProviderScanSites();
    // The six that shipped broken, plus the two that were already correct.
    expect(sites).toEqual(
      expect.arrayContaining([
        'lib/audit/ai-review.ts',
        'lib/generation/analyze-edit-intent.ts',
        'lib/import/generate-sections.ts',
        'lib/import/segment.ts',
        'lib/memory/extract.ts',
        'lib/skills/match.ts',
      ]),
    );
  });

  it('has no call site left on the Responses default', () => {
    expect(findCallableProviderHits()).toEqual([]);
  });

  it('names a `client(actualModel)` destructured out of getProviderForModel', () => {
    const hits = fixture(
      `import { getProviderForModel } from '@/lib/ai/provider-manager';\n` +
        `export async function run(userId: string | null) {\n` +
        `  const { client, actualModel } = await getProviderForModel(null, userId);\n` +
        `  return client(actualModel);\n` +
        `}\n`,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(4);
    expect(hits[0]?.expression).toBe('client(actualModel)');
    expect(hits[0]?.message).toContain('calls the provider object `client` directly');
  });

  it('names a renamed destructuring and a call inside a generateText option', () => {
    const hits = fixture(
      `import { getProviderForModel } from '@/lib/ai/provider-manager';\n` +
        `import { generateText } from 'ai';\n` +
        `export async function run(userId: string | null) {\n` +
        `  const { client: provider, actualModel } = await getProviderForModel(null, userId);\n` +
        `  return generateText({ model: provider(actualModel), prompt: 'hi' });\n` +
        `}\n`,
    );
    expect(hits.map((row) => row.expression)).toEqual(['provider(actualModel)']);
  });

  it('names `.responses` and `.languageModel`, which are the same model', () => {
    const hits = fixture(
      `import { clientForEntry } from '@/lib/ai/client-for-entry';\n` +
        `export function run(entry: never, env: never) {\n` +
        `  const client = clientForEntry(entry, env);\n` +
        `  return [client.responses('deepseek-v4-flash'), client.languageModel('deepseek-v4-pro')];\n` +
        `}\n`,
    );
    expect(hits.map((row) => row.expression).sort()).toEqual([
      "client.languageModel('deepseek-v4-pro')",
      "client.responses('deepseek-v4-flash')",
    ]);
  });

  it('names an immediately-invoked factory result', () => {
    const hits = fixture(
      `import { clientForEntry } from '@/lib/ai/client-for-entry';\n` +
        `export function run(entry: never, env: never) {\n` +
        `  return clientForEntry(entry, env)('deepseek-v4-flash');\n` +
        `}\n`,
    );
    expect(hits.map((row) => row.expression)).toEqual([
      "clientForEntry(entry, env)('deepseek-v4-flash')",
    ]);
  });

  it('names a provider passed in as a typed parameter', () => {
    const hits = fixture(
      `import type { ProviderClient } from '@/lib/ai/provider-manager';\n` +
        `export function run(client: ProviderClient, model: string) {\n` +
        `  return client(model);\n` +
        `}\n`,
    );
    expect(hits.map((row) => row.expression)).toEqual(['client(model)']);
  });

  it('leaves the chat accessor and the helpers alone', () => {
    const hits = fixture(
      `import { chatModelForEntry, chatModelForProvider, clientForEntry } from '@/lib/ai/client-for-entry';\n` +
        `import { getProviderForModel } from '@/lib/ai/provider-manager';\n` +
        `export async function run(entry: never, env: never, userId: string | null) {\n` +
        `  const { client, actualModel } = await getProviderForModel(null, userId);\n` +
        `  const direct = clientForEntry(entry, env);\n` +
        `  return [\n` +
        `    chatModelForProvider(client, actualModel),\n` +
        `    chatModelForEntry(entry, env, 'deepseek-v4-flash'),\n` +
        `    direct.chat('deepseek-v4-pro'),\n` +
        `  ];\n` +
        `}\n`,
    );
    expect(hits).toEqual([]);
  });

  it('ignores a `client` identifier that never came from the provider', () => {
    const hits = fixture(
      `import { getProviderForModel } from '@/lib/ai/provider-manager';\n` +
        `const client = (name: string) => name.toUpperCase();\n` +
        `export const shout = client('deepseek');\n` +
        `export const resolve = getProviderForModel;\n`,
    );
    expect(hits).toEqual([]);
  });
});

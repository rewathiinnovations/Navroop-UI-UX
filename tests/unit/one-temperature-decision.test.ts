/**
 * A `temperature` on a DeepSeek request is decided in exactly one place.
 *
 * F-041 was two call sites disagreeing about whether `-pro` may carry a temperature. The
 * repair was `temperatureForModel`, whose own doc says the decision is "used by every call
 * site" — and then six call sites went on ignoring it, because a doc comment is not a
 * mechanism. `lib/memory/extract.ts` proved it twice over: the endpoint rollout moved it to
 * `chatModelForProvider` and left `temperature: 0` on the next line, so the fix that was
 * supposed to revive memory extraction handed it a second way to die. Every model on offer
 * is a thinking model, `clientForEntry` injects `thinking: { type: 'enabled' }` into every
 * body it builds, DeepSeek refuses a request carrying both, and
 * `extractMemoriesAfterGeneration` catches everything — so the refusal surfaced as
 * `[memory] extraction failed` in a log nobody reads and `{ ok: true, inserted: 0 }` to the
 * caller.
 *
 * So this walks the tree instead of asking. Modelled on `no-callable-provider.test.ts`: an
 * exported pure finder over an explicit cwd/roots, asserted against the real tree and
 * against synthetic fixtures, plus a list of the files the walk actually reached so a guard
 * that has quietly stopped matching anything cannot keep passing.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { generateText } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import { chatModelForProvider, clientForEntry } from '@/lib/ai/client-for-entry';
import type { ProviderEntry } from '@/lib/ai/providers';
import { temperatureForModel } from '@/lib/ai/temperature';

const ROOTS = ['lib', 'app', 'components', 'scripts'] as const;

const SKIP_DIRS = new Set(['node_modules', '.next', 'coverage', 'dist', 'generated']);

/** The one decision. Anything else on a `temperature` is a second opinion (F-041). */
const DECISION = 'temperatureForModel';

/**
 * Only files that reach *this app's* DeepSeek provider are scanned, because the rule is a
 * DeepSeek-thinking-mode rule and not a general ban. `lib/assets/alt-text.ts` posts
 * `temperature: 0.2` straight to api.openai.com with the operator's own OpenAI key, where
 * the option is legal and refusing it would be wrong; a raw `fetch` aimed at DeepSeek is
 * still caught, because the base URL is a marker too.
 */
const PROVIDER_MARKERS =
  /getProviderForModel|clientForEntry|chatModelForEntry|chatModelForProvider|requireUsableProviderChain|loadProviderChain|DEEPSEEK_DEFAULT_BASE_URL|api\.deepseek\.com/;

export type HardCodedTemperatureHit = {
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

/** `await x`, `(x)`, `x as T`, `x!` all wrap the value we care about. */
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

function isDecisionCall(expression: ts.Expression): boolean {
  const inner = unwrap(expression);
  return ts.isCallExpression(inner) && calleeName(inner) === DECISION;
}

/**
 * The generate route asks the decision once and assigns the answer later
 * (`const temperature = temperatureForModel(actualModel)` … `streamOptions.temperature =
 * temperature`), so the binding has to count. Names are collected in a full pass before any
 * assignment is judged, as in the sibling guard.
 */
function collectDecisionBindings(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.name) &&
      isDecisionCall(node.initializer)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

function isApproved(expression: ts.Expression, bindings: Set<string>): boolean {
  const inner = unwrap(expression);
  if (isDecisionCall(inner)) return true;
  return ts.isIdentifier(inner) && bindings.has(inner.text);
}

/** `temperature:` / `'temperature':` on an object literal. */
function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return null;
}

/** `options.temperature = …` / `options['temperature'] = …`. */
function assignedPropertyName(left: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(left)) return left.name.text;
  if (ts.isElementAccessExpression(left) && ts.isStringLiteral(left.argumentExpression)) {
    return left.argumentExpression.text;
  }
  return null;
}

function hit(sf: ts.SourceFile, node: ts.Node, file: string): HardCodedTemperatureHit {
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const expression = node.getText(sf).split('\n')[0]!.trim();
  return {
    file,
    line,
    expression,
    message:
      `${file}:${line} decides a temperature itself — call ${DECISION}(model) instead. ` +
      `Every offered DeepSeek model is a thinking model and clientForEntry sends ` +
      `thinking: { type: 'enabled' }; the provider rejects a request that also carries a ` +
      `temperature, and most of these callers swallow the refusal (F-041)`,
  };
}

type Scan = { hits: HardCodedTemperatureHit[]; sites: Set<string> };

function scan(options: { cwd?: string; roots?: string[] } = {}): Scan {
  const cwd = options.cwd ?? process.cwd();
  const rootDirs = options.roots ?? ROOTS.map((root) => join(cwd, root));
  const files: string[] = [];
  for (const dir of rootDirs) {
    if (!existsSync(dir)) throw new Error(`temperature scan root is missing: ${dir}`);
    files.push(...tsFiles(dir));
  }

  const hits: HardCodedTemperatureHit[] = [];
  const sites = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('temperature') || !PROVIDER_MARKERS.test(source)) continue;
    const rel = posix(file, cwd);
    const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
    const bindings = collectDecisionBindings(sf);

    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'temperature') {
        sites.add(rel);
        if (!isApproved(node.initializer, bindings)) hits.push(hit(sf, node, rel));
      } else if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'temperature') {
        sites.add(rel);
        if (!bindings.has(node.name.text)) hits.push(hit(sf, node, rel));
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        assignedPropertyName(node.left) === 'temperature'
      ) {
        sites.add(rel);
        if (!isApproved(node.right, bindings)) hits.push(hit(sf, node, rel));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { hits, sites };
}

export function findHardCodedTemperatureHits(
  options: { cwd?: string; roots?: string[] } = {},
): HardCodedTemperatureHit[] {
  return scan(options).hits;
}

/**
 * Files where the walk actually found a temperature. A guard that matches nothing passes
 * forever, which is the failure mode this repo has already paid for.
 */
export function temperatureScanSites(options: { cwd?: string } = {}): string[] {
  return [...scan(options).sites].sort();
}

function fixture(body: string): HardCodedTemperatureHit[] {
  const dir = mkdtempSync(join(tmpdir(), 'navroop-temperature-'));
  writeFileSync(join(dir, 'call-site.ts'), body);
  return findHardCodedTemperatureHits({ cwd: dir, roots: [dir] });
}

describe('one temperature decision, enforced by walking the tree (F-041)', () => {
  it('reaches the call sites that actually send one', () => {
    expect(temperatureScanSites()).toEqual(
      expect.arrayContaining(['app/api/generate-ai-code-stream/route.ts', 'lib/memory/extract.ts']),
    );
  });

  it('has no provider call site deciding a temperature for itself', () => {
    expect(findHardCodedTemperatureHits()).toEqual([]);
  });

  it('names the literal that kept memory extraction dead after the endpoint fix', () => {
    const hits = fixture(
      `import { generateText } from 'ai';\n` +
        `import { chatModelForProvider } from '@/lib/ai/client-for-entry';\n` +
        `import { getProviderForModel } from '@/lib/ai/provider-manager';\n` +
        `export async function complete(userId: string | null) {\n` +
        `  const { client, actualModel } = await getProviderForModel(null, userId);\n` +
        `  return generateText({\n` +
        `    model: chatModelForProvider(client, actualModel),\n` +
        `    temperature: 0,\n` +
        `    prompt: 'hi',\n` +
        `  });\n` +
        `}\n`,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(8);
    expect(hits[0]?.expression).toBe('temperature: 0');
    expect(hits[0]?.message).toContain('temperatureForModel(model)');
  });

  it('accepts the shared decision, called inline or bound first', () => {
    expect(
      fixture(
        `import { generateText } from 'ai';\n` +
          `import { chatModelForProvider } from '@/lib/ai/client-for-entry';\n` +
          `import { temperatureForModel } from '@/lib/ai/temperature';\n` +
          `export function inline(client: never, model: string) {\n` +
          `  return generateText({\n` +
          `    model: chatModelForProvider(client, model),\n` +
          `    temperature: temperatureForModel(model),\n` +
          `    prompt: 'hi',\n` +
          `  });\n` +
          `}\n`,
      ),
    ).toEqual([]);

    // The generate route's shape: ask once, assign later.
    expect(
      fixture(
        `import { chatModelForEntry } from '@/lib/ai/client-for-entry';\n` +
          `import { temperatureForModel } from '@/lib/ai/temperature';\n` +
          `export function bound(model: string) {\n` +
          `  const streamOptions: { temperature?: number } = {};\n` +
          `  const temperature = temperatureForModel(model);\n` +
          `  if (temperature !== undefined) streamOptions.temperature = temperature;\n` +
          `  return [streamOptions, chatModelForEntry];\n` +
          `}\n`,
      ),
    ).toEqual([]);
  });

  it('refuses a second decision even when it currently agrees', () => {
    // `undefined` is the right answer today. Spelling it here is how the rule ends up
    // stated in two places again, and the next non-reasoning model makes them disagree.
    const hits = fixture(
      `import { getProviderForModel } from '@/lib/ai/provider-manager';\n` +
        `export const options = { temperature: undefined, resolve: getProviderForModel };\n`,
    );
    expect(hits.map((row) => row.expression)).toEqual(['temperature: undefined']);
  });

  it('refuses the pre-F-041 conditional, however it is spelled', () => {
    const hits = fixture(
      `import { chatModelForEntry } from '@/lib/ai/client-for-entry';\n` +
        `export function build(model: string) {\n` +
        `  const fallback = 0.7;\n` +
        `  return {\n` +
        `    a: { temperature: model.includes('-pro') ? undefined : 0.7, chatModelForEntry },\n` +
        `    b: { temperature: fallback },\n` +
        `  };\n` +
        `}\n`,
    );
    expect(hits.map((row) => row.expression)).toEqual([
      "temperature: model.includes('-pro') ? undefined : 0.7",
      'temperature: fallback',
    ]);
  });

  it('catches a shorthand property and a bracketed assignment', () => {
    const hits = fixture(
      `import { clientForEntry } from '@/lib/ai/client-for-entry';\n` +
        `export function build(body: Record<string, unknown>) {\n` +
        `  const temperature = 0.4;\n` +
        `  body['temperature'] = 0.9;\n` +
        `  return { temperature, clientForEntry, body };\n` +
        `}\n`,
    );
    expect(hits.map((row) => row.expression)).toEqual(["body['temperature'] = 0.9", 'temperature']);
  });

  it('leaves a non-DeepSeek provider alone — the rule is about thinking mode', () => {
    // The shape of `lib/assets/alt-text.ts`: the operator's own OpenAI key, OpenAI's own
    // endpoint, where a temperature is a supported option and not a rejected request.
    expect(
      fixture(
        `export function askOpenAI(apiKey: string, prompt: string) {\n` +
          `  return fetch('https://api.openai.com/v1/chat/completions', {\n` +
          `    method: 'POST',\n` +
          `    headers: { Authorization: 'Bearer ' + apiKey },\n` +
          `    body: JSON.stringify({ model: 'gpt-5-mini', temperature: 0.2, prompt }),\n` +
          `  });\n` +
          `}\n`,
      ),
    ).toEqual([]);
  });

  it('still catches a raw fetch aimed at DeepSeek', () => {
    const hits = fixture(
      `export function ask(apiKey: string) {\n` +
        `  return fetch('https://api.deepseek.com/chat/completions', {\n` +
        `    method: 'POST',\n` +
        `    headers: { Authorization: 'Bearer ' + apiKey },\n` +
        `    body: JSON.stringify({ model: 'deepseek-v4-pro', temperature: 0.7 }),\n` +
        `  });\n` +
        `}\n`,
    );
    expect(hits.map((row) => row.expression)).toEqual(['temperature: 0.7']);
  });
});

/**
 * The wire body, because the whole finding is about what DeepSeek receives. The static
 * guard above says nobody writes a literal; this says the shared decision actually keeps
 * the option off the request that carries thinking — the combination the provider refuses.
 */
const ENTRY: ProviderEntry = {
  id: 'deepseek',
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
};

const ENV: Record<string, string | undefined> = {
  // Spaces on purpose: `scanFilesForSecrets`' `generic-secret-assignment` rule
  // matches any 20+ character value drawn from `[A-Za-z0-9_\-/+=]`, so the previous
  // `'fixture-not-a-credential'` (24 characters, all in that class) failed the
  // secret scan the moment this file became tracked. A value with a space in it
  // cannot match, and reads the same to a human.
  DEEPSEEK_API_KEY: 'not a real key',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
};

const COMPLETION = {
  id: 'chatcmpl-fixture',
  object: 'chat.completion',
  created: 0,
  model: ENTRY.model,
  choices: [
    { index: 0, message: { role: 'assistant', content: '[]' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * `clientForEntry` builds its reasoning fetch over whatever `globalThis.fetch` is at
 * construction time, so the stub has to be installed before the client is built. Nothing
 * leaves the process: the stub answers every call itself.
 */
async function bodySentWith(temperature: number | undefined) {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : {});
    return new Response(JSON.stringify(COMPLETION), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  await generateText({
    model: chatModelForProvider(clientForEntry(ENTRY, ENV), ENTRY.model),
    temperature,
    prompt: 'anything durable here?',
  });
  return bodies[0] ?? {};
}

describe('what the memory-extraction request actually puts on the wire', () => {
  it('sends thinking and no temperature at all', async () => {
    // `thinking: true` is what this ENV resolves to, and it is the reading the
    // client below is built from — the same one the real call site now passes.
    const body = await bodySentWith(temperatureForModel(ENTRY.model, { thinking: true }));

    expect(body.thinking).toEqual({ type: 'enabled' });
    // Not `toBeUndefined()`: the key must be absent from the JSON, which is what makes the
    // request legal rather than merely null-valued.
    expect(Object.keys(body)).not.toContain('temperature');
  });

  it('would have sent both under the literal this call site used to carry', async () => {
    const body = await bodySentWith(0);

    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.temperature).toBe(0);
  });
});

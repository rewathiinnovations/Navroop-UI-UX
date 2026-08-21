/* temporary: canonical authz classification snapshot for F-845 bracketing */
import { readFileSync } from 'node:fs';
import { ACTION_AUTHZ, discoverUseServerModules } from '../tests/support/action-authz-registry';
import { MUTATING_ROUTE_POLICIES } from '../lib/auth/route-policy';
import { collectRouteEndpoints } from '../lib/auth/route-inventory';

const lines: string[] = [];
const modules = [...ACTION_AUTHZ].sort((a, b) => a.id.localeCompare(b.id));
lines.push(`MODULES=${modules.length}`);
for (const id of discoverUseServerModules().sort()) lines.push(`USESERVER ${id}`);
lines.push(`DISCOVERED=${discoverUseServerModules().length}`);
let exportCount = 0;
for (const m of modules) {
  for (const name of Object.keys(m.exports).sort()) {
    exportCount += 1;
    const e = m.exports[name]!;
    lines.push(`ACTION ${m.id}::${name}=${e.gate}${e.why ? ' why' : ''}`);
  }
}
lines.push(`ACTION_EXPORTS=${exportCount}`);

const routes = [...MUTATING_ROUTE_POLICIES].sort((a, b) =>
  `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`),
);
lines.push(`ROUTES=${routes.length}`);
for (const r of routes) {
  const rec = r as unknown as Record<string, unknown>;
  lines.push(
    `ROUTE ${r.method} ${r.path} gate=${String(rec.gate)} action=${String(rec.action ?? '-')}`,
  );
}

const MUTATING: Record<string, true> = { POST: true, PUT: true, PATCH: true, DELETE: true };
const endpoints = collectRouteEndpoints()
  .filter((e) => MUTATING[e.method])
  .map((e) => `${e.method} ${e.pattern}`)
  .sort();
lines.push(`MUTATING_ENDPOINTS=${endpoints.length}`);
for (const e of endpoints) lines.push(`ENDPOINT ${e}`);

const src = readFileSync('tests/unit/mutating-route-authz.test.ts', 'utf8');
const table = src.slice(
  src.indexOf('const ROUTE_AUTHZ'),
  src.indexOf('\n};', src.indexOf('const ROUTE_AUTHZ')),
);
lines.push(`ROUTE_AUTHZ_KEYS=${(table.match(/^\s{2}'[^']+':/gm) ?? []).length}`);
process.stdout.write(lines.join('\n') + '\n');

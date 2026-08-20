// Ledger maintenance: node audit/_ledger.mjs '<json>'
// json: [{"ids":["F-001","F-020"],"disposition":"FIXED","commit":"abc1234","note":"..."}]
// Only touches audit/FIXES.md rows whose id matches; leaves everything else byte-identical.
import { readFileSync, writeFileSync } from 'node:fs';

const updates = JSON.parse(process.argv[2]);
const byId = new Map();
for (const u of updates) for (const id of u.ids) byId.set(id, u);

const lines = readFileSync('audit/FIXES.md', 'utf8').split('\n');
let changed = 0;
const out = lines.map((line) => {
  if (!line.startsWith('| F-')) return line;
  const cells = line.split('|'); // ['', ' id ', ' sev ', ' area ', ' group ', ' disp ', ' wave ', ' commit ', ' note ', '']
  const id = cells[1].trim();
  const u = byId.get(id);
  if (!u) return line;
  changed += 1;
  if (u.disposition) cells[5] = ` ${u.disposition} `;
  if (u.commit) cells[7] = ` ${u.commit} `;
  if (u.note) cells[8] = ` ${u.note} `;
  return cells.join('|');
});
writeFileSync('audit/FIXES.md', out.join('\n'), 'utf8');

const counts = {};
for (const line of out) {
  if (!line.startsWith('| F-')) continue;
  const d = line.split('|')[5].trim();
  counts[d] = (counts[d] ?? 0) + 1;
}
console.log(`updated ${changed} rows; dispositions now:`, JSON.stringify(counts));

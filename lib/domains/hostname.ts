const HOST_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalizeHostname(raw: string): string | null {
  let value = String(raw || '')
    .trim()
    .toLowerCase();
  if (!value) return null;
  value = value.replace(/^https?:\/\//, '');
  value = value.split('/')[0] ?? value;
  value = value.split('?')[0] ?? value;
  value = value.split('#')[0] ?? value;
  if (value.includes(':') && !value.startsWith('[')) {
    value = value.replace(/:\d+$/, '');
  }
  value = value.replace(/\.$/, '');
  if (!HOST_RE.test(value)) return null;
  if (value === 'localhost' || value.endsWith('.localhost')) return null;
  return value;
}

/**
 * Apex/zone detection by label count was wrong for multi-label public suffixes (F-220):
 * `example.co.in` counted as three labels and was treated as a subdomain, so we asked for a
 * CNAME at a zone apex (invalid DNS that can never verify) and Path B tried to register `co.in`
 * as a customer zone.
 *
 * No public-suffix package is installed and no dependency may be added this wave, so this is an
 * explicit, deliberately incomplete list of the common multi-label suffixes. A hostname whose
 * registrable domain cannot be determined confidently returns `null` from `registrableDomain`
 * and `zoneNameForHostname`, and is refused for Path B rather than guessed.
 */
const MULTI_LABEL_SUFFIXES: Record<string, true> = {
  'co.uk': true,
  'ac.uk': true,
  'org.uk': true,
  'gov.uk': true,
  'net.uk': true,
  'sch.uk': true,
  'co.in': true,
  'net.in': true,
  'org.in': true,
  'firm.in': true,
  'gen.in': true,
  'ind.in': true,
  'com.au': true,
  'net.au': true,
  'org.au': true,
  'edu.au': true,
  'gov.au': true,
  'co.nz': true,
  'net.nz': true,
  'org.nz': true,
  'co.za': true,
  'org.za': true,
  'web.za': true,
  'com.br': true,
  'net.br': true,
  'org.br': true,
  'co.jp': true,
  'ne.jp': true,
  'or.jp': true,
  'ac.jp': true,
  'com.mx': true,
  'co.kr': true,
  'or.kr': true,
  'com.tr': true,
  'com.sg': true,
  'co.il': true,
  'org.il': true,
  'com.cn': true,
  'net.cn': true,
  'org.cn': true,
  'com.hk': true,
  'com.pk': true,
  'com.ng': true,
  'com.ar': true,
  'com.co': true,
  'co.th': true,
  'com.my': true,
  'com.ph': true,
  'com.tw': true,
  'com.ua': true,
  'co.id': true,
  'com.vn': true,
  'com.sa': true,
  'com.eg': true,
};

/**
 * Second-level labels that appear in the list above. When one of them sits under an unknown
 * two-letter ccTLD (e.g. `co.zz`), we cannot tell a public suffix from a registrable name, so we
 * refuse rather than guess — that is the ambiguous case the audit calls out.
 */
const SUFFIX_SECOND_LEVELS: Record<string, true> = {
  co: true,
  ac: true,
  org: true,
  gov: true,
  net: true,
  sch: true,
  firm: true,
  gen: true,
  ind: true,
  com: true,
  edu: true,
  ne: true,
  or: true,
  web: true,
};

/**
 * The registrable domain (eTLD+1), or `null` when it cannot be determined confidently. `null`
 * means "refuse Path B" — never a guessed zone name handed to Cloudflare.
 */
export function registrableDomain(hostname: string): string | null {
  const labels = hostname.split('.');
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES[lastTwo]) {
    return labels.length >= 3 ? labels.slice(-3).join('.') : null;
  }
  const tld = labels[labels.length - 1] ?? '';
  const secondLevel = labels[labels.length - 2] ?? '';
  if (labels.length >= 3 && tld.length === 2 && SUFFIX_SECOND_LEVELS[secondLevel]) {
    return null;
  }
  return lastTwo;
}

export function isApexHostname(hostname: string) {
  const registrable = registrableDomain(hostname);
  return registrable === null || hostname === registrable;
}

/** The zone name to register on Cloudflare (Path B). `null` = refuse. */
export function zoneNameForHostname(hostname: string): string | null {
  return registrableDomain(hostname);
}

/**
 * The DNS record label relative to the zone: `@` at the apex, the sub-label otherwise. When the
 * registrable domain is unknown the full hostname is the only safe label to publish.
 */
export function subdomainLabelFor(hostname: string): string {
  const registrable = registrableDomain(hostname);
  if (registrable === null) return hostname;
  if (hostname === registrable) return '@';
  const suffix = `.${registrable}`;
  return hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : hostname;
}

export function isOurZone(hostname: string, zone: string) {
  const root = zone.replace(/\.$/, '').toLowerCase();
  const host = hostname.replace(/\.$/, '').toLowerCase();
  return host === root || host.endsWith(`.${root}`);
}

export function verifyTxtName(hostname: string) {
  return `_navroop-verify.${hostname}`;
}

export function stripDnsDot(value: string) {
  return value.replace(/\.$/, '').toLowerCase();
}

const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalizeHostname(raw: string): string | null {
  let value = String(raw || '').trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^https?:\/\//, '');
  value = value.split('/')[0] ?? value;
  value = value.split('?')[0] ?? value;
  value = value.split('#')[0] ?? value;
  if (value.includes(':') && !value.startsWith('[')) {
    value = value.replace(/:\d+$/, '');
  }
  value = value.replace(/\.$/, '');
  if (value.startsWith('www.') === false && value.includes(' ')) return null;
  if (!HOST_RE.test(value)) return null;
  if (value === 'localhost' || value.endsWith('.localhost')) return null;
  return value;
}

export function isApexHostname(hostname: string) {
  return hostname.split('.').length === 2;
}

export function zoneNameForHostname(hostname: string) {
  const labels = hostname.split('.');
  if (labels.length <= 2) return hostname;
  return labels.slice(-2).join('.');
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

import { usageRangeQuerySchema } from '@/lib/usage-costs';

export function defaultQualityRange(now = new Date()) {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from, to };
}

function parseBound(value: string, edge: 'start' | 'end') {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return edge === 'start'
      ? new Date(Date.UTC(year, month - 1, day))
      : new Date(Date.UTC(year, month - 1, day + 1));
  }
  return new Date(value);
}

export function parseQualityRange(searchParams: URLSearchParams) {
  const parsed = usageRangeQuerySchema.safeParse({
    from: searchParams.get('from') ?? undefined,
    to: searchParams.get('to') ?? undefined,
  });
  if (!parsed.success) {
    return {
      ok: false as const,
      error: 'Validation failed' as const,
      status: 400 as const,
      details: parsed.error.issues,
    };
  }

  const defaults = defaultQualityRange();
  const from = parsed.data.from ? parseBound(parsed.data.from, 'start') : defaults.from;
  const to = parsed.data.to ? parseBound(parsed.data.to, 'end') : defaults.to;
  if (!(from < to)) {
    return {
      ok: false as const,
      error: 'Validation failed' as const,
      status: 400 as const,
      details: [{ message: '`from` must be before `to`' }],
    };
  }
  return { ok: true as const, data: { from, to } };
}

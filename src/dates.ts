const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export class InputError extends Error {}

/** Today's calendar date (YYYY-MM-DD) in the given IANA time zone. */
export function today(timeZone = 'UTC'): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
      new Date()
    );
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function parseDate(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new InputError(`${name} must be a date in YYYY-MM-DD format`);
  }
  return value;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS);
}

/**
 * Resolve an inclusive date range from optional tool arguments.
 * Defaults to the `defaultDays` days ending today; rejects ranges longer than `maxDays`.
 */
export function resolveRange(
  args: Record<string, unknown>,
  timeZone: string | undefined,
  defaultDays: number,
  maxDays: number
): { start: string; end: string } {
  const end = args.end_date === undefined ? today(timeZone) : parseDate(args.end_date, 'end_date');
  let start: string;
  if (args.start_date !== undefined) {
    start = parseDate(args.start_date, 'start_date');
  } else {
    const days = args.days === undefined ? defaultDays : Number(args.days);
    if (!Number.isInteger(days) || days < 1) throw new InputError('days must be a positive integer');
    start = addDays(end, -(days - 1));
  }
  const span = daysBetween(start, end) + 1;
  if (span < 1) throw new InputError('start_date must not be after end_date');
  if (span > maxDays) throw new InputError(`range is ${span} days; this tool allows at most ${maxDays}`);
  return { start, end };
}

/** Split an inclusive range into consecutive windows of at most `maxDays` days. */
export function windows(start: string, end: string, maxDays: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let cursor = start;
  while (daysBetween(cursor, end) >= 0) {
    const windowEnd = daysBetween(addDays(cursor, maxDays - 1), end) < 0 ? end : addDays(cursor, maxDays - 1);
    out.push([cursor, windowEnd]);
    cursor = addDays(windowEnd, 1);
  }
  return out;
}

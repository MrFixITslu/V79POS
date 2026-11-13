export type ReportPeriod = 'week' | 'month' | 'year';
export type TimeBucket = {
  key: string;
  label: string;
  from: Date;
  to: Date;
};

// Work with local calendar dates, not rolling 7/30/365-day approximations.
// Conversion to UTC is done only at database query boundaries.
function localParts(instant: Date, timeZone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(instant).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return { year: values.year, month: values.month, day: values.day,
    hour: values.hour, minute: values.minute, second: values.second };
}

function midnightUtc(calendarDate: Date, timeZone: string): Date {
  const wanted = Date.UTC(calendarDate.getUTCFullYear(), calendarDate.getUTCMonth(), calendarDate.getUTCDate());
  let candidate = wanted;
  for (let i = 0; i < 3; i += 1) {
    const local = localParts(new Date(candidate), timeZone);
    const observed = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    candidate += wanted - observed;
  }
  return new Date(candidate);
}

function addPeriod(date: Date, period: ReportPeriod, amount: number) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  if (period === 'year') return new Date(Date.UTC(year + amount, 0, 1));
  if (period === 'month') return new Date(Date.UTC(year, month + amount, 1));
  return new Date(Date.UTC(year, month, day + amount * 7));
}

function key(date: Date, period: ReportPeriod) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return period === 'year' ? String(year) : period === 'month' ? year + '-' + month : year + '-' + month + '-' + day;
}

function label(date: Date, period: ReportPeriod) {
  if (period === 'year') return String(date.getUTCFullYear());
  if (period === 'month') return new Intl.DateTimeFormat('en-GB', {
    month: 'short', year: 'numeric', timeZone: 'UTC'
  }).format(date);
  return 'Week of ' + new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
  }).format(date);
}

export function completedBuckets(period: ReportPeriod, count: number, timeZone: string, now = new Date()): TimeBucket[] {
  if (!Number.isInteger(count) || count < 2 || count > 52) throw new Error('Invalid report period count');
  const local = localParts(now, timeZone);
  const today = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const boundary = period === 'year'
    ? new Date(Date.UTC(local.year, 0, 1))
    : period === 'month'
      ? new Date(Date.UTC(local.year, local.month - 1, 1))
      : new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * 86400_000);

  const buckets: TimeBucket[] = [];
  for (let i = count; i >= 1; i -= 1) {
    const from = addPeriod(boundary, period, -i);
    const to = addPeriod(boundary, period, 1 - i);
    buckets.push({ key: key(from, period), label: label(from, period),
      from: midnightUtc(from, timeZone), to: midnightUtc(to, timeZone) });
  }
  return buckets;
}

export function bucketFor(date: Date, buckets: TimeBucket[]): number {
  const timestamp = date.getTime();
  let lo = 0;
  let hi = buckets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const b = buckets[mid];
    if (timestamp < b.from.getTime()) hi = mid - 1;
    else if (timestamp >= b.to.getTime()) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export function relativeChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return Math.round((current - previous) / Math.abs(previous) * 10000) / 100;
}

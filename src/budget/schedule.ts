/**
 * Hours when a quota pool is not limited (ADR-0018 §4): the platform's nights and weekends. A span is
 * days of the week, a time of day `from`–`to` (over midnight when `to` is earlier), or both; spans that
 * touch run together (weeknights 22–07 and whole weekends make Friday 22:00 to Monday 07:00).
 * Times are in the pool's `timezone`, else the machine's.
 *
 * What a pool spent in such hours is not counted in its window afterwards: the platform did not count
 * it, so a run at 07:01 is not paused for the night's tokens.
 */
export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Day = (typeof DAYS)[number];

export interface UnlimitedSpan {
  readonly days?: readonly Day[] | undefined;
  /** `HH:MM`; none — from midnight. */
  readonly from?: string | undefined;
  /** `HH:MM`; none — to midnight. */
  readonly to?: string | undefined;
}

export interface Schedule {
  readonly spans: readonly UnlimitedSpan[];
  readonly timezone?: string;
}

const MINUTE = 60_000;
const DAY_MINUTES = 1440;

export const minutesOf = (hhmm: string | undefined, fallback: number): number => {
  if (hhmm === undefined) return fallback;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
};

/** Minutes the zone is ahead of UTC at this moment. */
export function offsetMinutes(at: Date, timezone?: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"));
  return Math.round((local - Math.floor(at.getTime() / MINUTE) * MINUTE) / MINUTE);
}

/** Is the local minute (minutes since the epoch, in local time) inside a span? */
function inSpans(spans: readonly UnlimitedSpan[], local: number): boolean {
  const day = Math.floor(local / DAY_MINUTES);
  const minute = local - day * DAY_MINUTES;
  // 1970-01-01 was a Thursday
  const dow = (d: number): Day => DAYS[(((d + 4) % 7) + 7) % 7] as Day;
  return spans.some((s) => {
    const ok = (d: number) => !s.days || s.days.length === 0 || s.days.includes(dow(d));
    const from = minutesOf(s.from, 0);
    const to = minutesOf(s.to, DAY_MINUTES);
    if (from === to || (from === 0 && to === DAY_MINUTES)) return ok(day);
    if (from < to) return minute >= from && minute < to && ok(day);
    // over midnight: the evening belongs to its day, the morning to the day before
    return (minute >= from && ok(day)) || (minute < to && ok(day - 1));
  });
}

/** Local minutes where a span may start or end, around `local`: each day's midnights and its spans' times. */
function boundaries(
  spans: readonly UnlimitedSpan[],
  local: number,
  daysBack: number,
  daysAhead: number,
): number[] {
  const today = Math.floor(local / DAY_MINUTES);
  const out: number[] = [];
  for (let d = today - daysBack; d <= today + daysAhead; d++) {
    out.push(d * DAY_MINUTES);
    for (const s of spans)
      for (const t of [minutesOf(s.from, 0), minutesOf(s.to, DAY_MINUTES)]) out.push(d * DAY_MINUTES + t);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

const localOf = (at: Date, timezone?: string) =>
  Math.floor(at.getTime() / MINUTE) + offsetMinutes(at, timezone);
const utcOf = (local: number, near: Date, timezone?: string) =>
  new Date((local - offsetMinutes(near, timezone)) * MINUTE);

export function unlimitedAt(schedule: Schedule, at: Date): boolean {
  return schedule.spans.length > 0 && inSpans(schedule.spans, localOf(at, schedule.timezone));
}

/** When the next unlimited hours begin (within a week), if they are not on now. */
export function nextUnlimited(schedule: Schedule, at: Date): Date | undefined {
  if (schedule.spans.length === 0 || unlimitedAt(schedule, at)) return undefined;
  const local = localOf(at, schedule.timezone);
  const start = boundaries(schedule.spans, local, 0, 8).find(
    (b) => b > local && inSpans(schedule.spans, b) && !inSpans(schedule.spans, b - 1),
  );
  return start === undefined ? undefined : utcOf(start, at, schedule.timezone);
}

/** When the unlimited hours on now end (within a week). */
export function unlimitedUntil(schedule: Schedule, at: Date): Date | undefined {
  if (!unlimitedAt(schedule, at)) return undefined;
  const local = localOf(at, schedule.timezone);
  const end = boundaries(schedule.spans, local, 0, 8).find((b) => b > local && !inSpans(schedule.spans, b));
  return end === undefined ? undefined : utcOf(end, at, schedule.timezone);
}

/** When the last unlimited hours ended, if within `withinMs` of now: what came before is not counted. */
export function lastUnlimitedEnd(schedule: Schedule, at: Date, withinMs: number): Date | undefined {
  if (schedule.spans.length === 0 || unlimitedAt(schedule, at)) return undefined;
  const local = localOf(at, schedule.timezone);
  const since = local - Math.ceil(withinMs / MINUTE);
  const ends = boundaries(schedule.spans, local, Math.ceil(withinMs / MINUTE / DAY_MINUTES) + 1, 0).filter(
    (b) => b <= local && b >= since && !inSpans(schedule.spans, b) && inSpans(schedule.spans, b - 1),
  );
  const end = ends.at(-1);
  return end === undefined ? undefined : utcOf(end, at, schedule.timezone);
}

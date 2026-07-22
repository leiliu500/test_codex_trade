const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, value);
  }
  return value;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(timestamp: number, timeZone = "America/New_York"): ZonedParts {
  const parts = formatter(timeZone).formatToParts(new Date(timestamp));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

export function marketDate(timestamp: number, timeZone = "America/New_York"): string {
  const p = zonedParts(timestamp, timeZone);
  return `${p.year.toString().padStart(4, "0")}-${p.month.toString().padStart(2, "0")}-${p.day.toString().padStart(2, "0")}`;
}

export function parseClock(clock: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(clock);
  if (!match) throw new Error(`Invalid session clock: ${clock}`);
  const [, h, m, s] = match;
  const seconds = Number(h) * 3600 + Number(m) * 60 + Number(s);
  if (Number(h) > 23 || Number(m) > 59 || Number(s) > 59) throw new Error(`Invalid session clock: ${clock}`);
  return seconds;
}

export function secondsSinceMidnight(timestamp: number, timeZone = "America/New_York"): number {
  const p = zonedParts(timestamp, timeZone);
  return p.hour * 3600 + p.minute * 60 + p.second;
}

export function isAtOrAfter(timestamp: number, clock: string, timeZone = "America/New_York"): boolean {
  return secondsSinceMidnight(timestamp, timeZone) >= parseClock(clock);
}

export function isBefore(timestamp: number, clock: string, timeZone = "America/New_York"): boolean {
  return secondsSinceMidnight(timestamp, timeZone) < parseClock(clock);
}

export function inSessionWindow(timestamp: number, start: string, end: string, timeZone = "America/New_York"): boolean {
  const current = secondsSinceMidnight(timestamp, timeZone);
  return current >= parseClock(start) && current <= parseClock(end);
}

export function fiveMinuteBucket(timestamp: number, timeZone = "America/New_York"): string {
  const p = zonedParts(timestamp, timeZone);
  const minute = Math.floor(p.minute / 5) * 5;
  return `${p.hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}

export function epochSecond(timestamp: number): number {
  return Math.floor(timestamp / 1000) * 1000;
}

/** Calendar business-day distance; exchange holidays must be supplied by a production calendar adapter. */
export function businessDaysBetween(fromDate: string, toDate: string): number {
  const from = new Date(`${fromDate}T12:00:00Z`);
  const to = new Date(`${toDate}T12:00:00Z`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) return Number.NaN;
  if (to < from) return -businessDaysBetween(toDate, fromDate);
  let days = 0;
  const cursor = new Date(from);
  while (cursor < to) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days += 1;
  }
  return days;
}

/** Convert a local date/time in an IANA zone to epoch milliseconds without hard-coded DST offsets. */
export function zonedDateTimeToEpoch(date: string, clock: string, timeZone = "America/New_York"): number {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second] = clock.split(":").map(Number);
  if ([year, month, day, hour, minute, second].some((x) => !Number.isFinite(x))) throw new Error("Invalid zoned date/time");
  let guess = Date.UTC(year!, month! - 1, day, hour, minute, second);
  for (let i = 0; i < 4; i += 1) {
    const p = zonedParts(guess, timeZone);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const desired = Date.UTC(year!, month! - 1, day, hour, minute, second);
    guess += desired - represented;
  }
  return guess;
}

/**
 * Public holidays from the Google holiday calendar of the user's country
 * (R30.2). The country comes from the phone's locale region (default CA).
 * Holidays are read for this and next year at most once a week, cached in the
 * `holidays` document, and handed to planning as a date list. A failed read
 * keeps the old cache and never throws, so planning just goes on without
 * (new) holidays and the next launch retries.
 */
import { torontoDateKey } from "@timeblocker/scheduling-engine";
import type { HolidayCache } from "../models.js";
import type { CalendarApi, Clock } from "../ports.js";
import type { Repositories } from "../repositories.js";

/** Google "Holidays in <country>" (public holidays only) calendar ids, by ISO country code. */
export const COUNTRY_HOLIDAY_CALENDARS: Record<string, string> = {
  CA: "en.canadian.official#holiday@group.v.calendar.google.com",
  US: "en.usa.official#holiday@group.v.calendar.google.com",
  GB: "en.uk.official#holiday@group.v.calendar.google.com",
  AU: "en.australian.official#holiday@group.v.calendar.google.com",
  IN: "en.indian.official#holiday@group.v.calendar.google.com",
  DE: "en.german.official#holiday@group.v.calendar.google.com",
  FR: "en.french.official#holiday@group.v.calendar.google.com",
  ES: "en.spain.official#holiday@group.v.calendar.google.com",
  IT: "en.italian.official#holiday@group.v.calendar.google.com",
  NL: "en.dutch.official#holiday@group.v.calendar.google.com",
  SE: "en.swedish.official#holiday@group.v.calendar.google.com",
  NO: "en.norwegian.official#holiday@group.v.calendar.google.com",
  DK: "en.danish.official#holiday@group.v.calendar.google.com",
  FI: "en.finnish.official#holiday@group.v.calendar.google.com",
  IE: "en.irish.official#holiday@group.v.calendar.google.com",
  NZ: "en.new_zealand.official#holiday@group.v.calendar.google.com",
  ZA: "en.sa.official#holiday@group.v.calendar.google.com",
  BR: "en.brazilian.official#holiday@group.v.calendar.google.com",
  MX: "en.mexican.official#holiday@group.v.calendar.google.com",
  JP: "en.japanese.official#holiday@group.v.calendar.google.com",
  KR: "en.south_korea.official#holiday@group.v.calendar.google.com",
  SG: "en.singapore.official#holiday@group.v.calendar.google.com",
  PH: "en.philippines.official#holiday@group.v.calendar.google.com",
  PK: "en.pk.official#holiday@group.v.calendar.google.com",
  NG: "en.ng.official#holiday@group.v.calendar.google.com",
  AE: "en.ae.official#holiday@group.v.calendar.google.com",
  AT: "en.austrian.official#holiday@group.v.calendar.google.com",
  CH: "en.ch.official#holiday@group.v.calendar.google.com",
  BE: "en.be.official#holiday@group.v.calendar.google.com",
  PL: "en.polish.official#holiday@group.v.calendar.google.com",
  PT: "en.portuguese.official#holiday@group.v.calendar.google.com",
  GR: "en.greek.official#holiday@group.v.calendar.google.com",
  CZ: "en.czech.official#holiday@group.v.calendar.google.com",
  TR: "en.turkish.official#holiday@group.v.calendar.google.com",
  HK: "en.hong_kong.official#holiday@group.v.calendar.google.com",
  TW: "en.taiwan.official#holiday@group.v.calendar.google.com",
  ID: "en.indonesian.official#holiday@group.v.calendar.google.com",
  MY: "en.malaysia.official#holiday@group.v.calendar.google.com",
  CN: "en.china.official#holiday@group.v.calendar.google.com",
};

const COUNTRY_NAMES: Record<string, string> = {
  CA: "Canada", US: "United States", GB: "United Kingdom", AU: "Australia", IN: "India",
  DE: "Germany", FR: "France", ES: "Spain", IT: "Italy", NL: "Netherlands", SE: "Sweden",
  NO: "Norway", DK: "Denmark", FI: "Finland", IE: "Ireland", NZ: "New Zealand",
  ZA: "South Africa", BR: "Brazil", MX: "Mexico", JP: "Japan", KR: "South Korea",
  SG: "Singapore", PH: "Philippines", PK: "Pakistan", NG: "Nigeria",
  AE: "United Arab Emirates", AT: "Austria", CH: "Switzerland", BE: "Belgium", PL: "Poland",
  PT: "Portugal", GR: "Greece", CZ: "Czechia", TR: "Turkey", HK: "Hong Kong", TW: "Taiwan",
  ID: "Indonesia", MY: "Malaysia", CN: "China",
};

export const DEFAULT_HOLIDAY_COUNTRY = "CA";
/** The cache is refreshed at most this often (and again when the year changes). */
export const HOLIDAY_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** The device locale, e.g. `en-CA` (injectable seam over `Intl`). */
export function deviceLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/** ISO region of a BCP-47 locale (`en-CA`, `en_CA`, `zh-Hans-CN` → `CA`, `CN`); default `CA`. */
export function countryFromLocale(locale?: string): string {
  if (!locale) return DEFAULT_HOLIDAY_COUNTRY;
  const subtags = locale.split(/[-_]/).slice(1);
  for (const tag of subtags) {
    if (tag.length === 1) break; // extension/private-use singleton
    if (/^[A-Za-z]{2}$/.test(tag)) return tag.toUpperCase();
  }
  return DEFAULT_HOLIDAY_COUNTRY;
}

/** Display name of a country code (the code itself when unknown). */
export function countryName(code: string): string {
  return COUNTRY_NAMES[code] ?? code;
}

export interface HolidayServiceDeps {
  repos: Repositories;
  calendar: Pick<CalendarApi, "readHolidays">;
  clock: Clock;
  /** ISO country code; defaults to the device locale's region. */
  country?: () => string;
}

export interface HolidaySummary {
  country: string;
  next?: { name: string; date: string };
}

export class HolidayService {
  private readonly country: () => string;

  constructor(private readonly deps: HolidayServiceDeps) {
    this.country = deps.country ?? (() => countryFromLocale(deviceLocale()));
  }

  /**
   * Fetch this year's and next year's holidays unless the cache is for this
   * country, from this year, and under 7 days old. Never throws; a failed or
   * empty read keeps the old cache.
   */
  async refreshIfStale(): Promise<void> {
    try {
      const { repos, calendar, clock } = this.deps;
      const country = this.country();
      const calendarId = COUNTRY_HOLIDAY_CALENDARS[country];
      if (!calendarId) return;
      const now = clock.now();
      const year = Number(torontoDateKey(new Date(now)).slice(0, 4));
      const cache = await repos.holidays.get();
      if (
        cache &&
        cache.country === country &&
        now >= cache.fetchedAt &&
        now - cache.fetchedAt < HOLIDAY_REFRESH_MS &&
        Number(torontoDateKey(new Date(cache.fetchedAt)).slice(0, 4)) === year
      ) {
        return;
      }
      if (!calendar.readHolidays) return;
      const found = await calendar.readHolidays(calendarId, `${year}-01-01T00:00:00Z`, `${year + 2}-01-01T00:00:00Z`);
      if (found.length === 0 && cache && cache.country === country && cache.items.length > 0) return;
      const seen = new Set<string>();
      const items = found
        .filter((h) => {
          const key = `${h.date}|${h.name}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => a.date.localeCompare(b.date));
      const next: HolidayCache = { country, fetchedAt: now, items };
      await repos.commit([repos.holidays.write(next)]);
    } catch {
      // Keep the old cache; the next launch or sync retries.
    }
  }

  private async items(): Promise<HolidayCache["items"]> {
    const cache = await this.deps.repos.holidays.get();
    return cache && cache.country === this.country() ? cache.items : [];
  }

  /** Sorted unique YYYY-MM-DD dates of the cached holidays. */
  async dates(): Promise<string[]> {
    return [...new Set((await this.items()).map((i) => i.date))].sort();
  }

  /** The country and the next holiday (today counts); `null` until holidays are cached. */
  async summary(): Promise<HolidaySummary | null> {
    const cache = await this.deps.repos.holidays.get();
    if (!cache || cache.country !== this.country()) return null;
    const today = torontoDateKey(new Date(this.deps.clock.now()));
    const next = [...cache.items].sort((a, b) => a.date.localeCompare(b.date)).find((i) => i.date >= today);
    return {
      country: countryName(cache.country),
      ...(next ? { next: { name: next.name, date: next.date } } : {}),
    };
  }

  /** The cached holiday name for a date, if any. */
  async holidayNameFor(date: string): Promise<string | undefined> {
    return (await this.items()).find((i) => i.date === date)?.name;
  }
}

/** Anything that can list holiday dates (the {@link HolidayService}). */
export interface HolidayDates {
  dates(): Promise<string[]>;
}

/** Settings holidays plus the country holidays; a failing source leaves the settings list. */
export async function allHolidays(settingsHolidays: readonly string[], source?: HolidayDates): Promise<string[]> {
  if (!source) return [...settingsHolidays];
  try {
    return [...new Set([...settingsHolidays, ...(await source.dates())])];
  } catch {
    return [...settingsHolidays];
  }
}

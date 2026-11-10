import { describe, expect, it } from "vitest";
import { Repositories } from "../repositories.js";
import { FakeCalendar, FakeClock, MemoryKeyValueStore } from "../testkit.js";
import {
  allHolidays,
  COUNTRY_HOLIDAY_CALENDARS,
  countryFromLocale,
  countryName,
  HolidayService,
  HOLIDAY_REFRESH_MS,
} from "./holidays.js";

const DAY = 24 * 60 * 60 * 1000;
const CA = COUNTRY_HOLIDAY_CALENDARS.CA!;
const T0 = Date.parse("2025-06-15T16:00:00Z");

function setup(opts: { country?: string; now?: number } = {}) {
  const repos = new Repositories(new MemoryKeyValueStore());
  const clock = new FakeClock(opts.now ?? T0);
  const calendar = new FakeCalendar();
  let country = opts.country ?? "CA";
  const service = new HolidayService({ repos, calendar, clock, country: () => country });
  return { repos, clock, calendar, service, setCountry: (c: string) => (country = c) };
}

const CA_HOLIDAYS = [
  { date: "2025-07-01", name: "Canada Day" },
  { date: "2025-12-25", name: "Christmas Day" },
  { date: "2026-01-01", name: "New Year's Day" },
];

describe("country map", () => {
  it("maps ISO codes to Google public-holiday calendar ids", () => {
    for (const [code, id] of Object.entries(COUNTRY_HOLIDAY_CALENDARS)) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(id).toMatch(/^en\.[a-z_]+\.official#holiday@group\.v\.calendar\.google\.com$/);
    }
    expect(COUNTRY_HOLIDAY_CALENDARS.CA).toBe("en.canadian.official#holiday@group.v.calendar.google.com");
    expect(Object.keys(COUNTRY_HOLIDAY_CALENDARS).length).toBeGreaterThanOrEqual(25);
    expect(new Set(Object.values(COUNTRY_HOLIDAY_CALENDARS)).size).toBe(Object.keys(COUNTRY_HOLIDAY_CALENDARS).length);
  });

  it("has a display name for every mapped country", () => {
    for (const code of Object.keys(COUNTRY_HOLIDAY_CALENDARS)) expect(countryName(code)).not.toBe(code);
    expect(countryName("XX")).toBe("XX");
  });
});

describe("countryFromLocale", () => {
  it.each([
    ["en-CA", "CA"],
    ["en_US", "US"],
    ["fr-fr", "FR"],
    ["zh-Hans-CN", "CN"],
    ["en-u-ca-gregory", "CA"],
    ["en", "CA"],
    ["en-001", "CA"],
    ["", "CA"],
    [undefined, "CA"],
  ])("%s → %s", (locale, expected) => {
    expect(countryFromLocale(locale)).toBe(expected);
  });
});

describe("HolidayService.refreshIfStale", () => {
  it("reads this and next year from the country calendar and caches them", async () => {
    const { repos, calendar, service } = setup();
    calendar.setHolidays(CA, CA_HOLIDAYS);
    await service.refreshIfStale();
    const cache = await repos.holidays.get();
    expect(cache).toEqual({ country: "CA", fetchedAt: T0, items: CA_HOLIDAYS });
    expect(calendar.calls.filter((c) => c.op === "readHolidays")).toHaveLength(1);
  });

  it("does not refetch within 7 days, refetches after", async () => {
    const { calendar, clock, service } = setup();
    calendar.setHolidays(CA, CA_HOLIDAYS);
    await service.refreshIfStale();
    clock.advance(HOLIDAY_REFRESH_MS - DAY / 2);
    await service.refreshIfStale();
    expect(calendar.opLog()).toEqual(["readHolidays"]);
    clock.advance(DAY);
    await service.refreshIfStale();
    expect(calendar.opLog()).toEqual(["readHolidays", "readHolidays"]);
  });

  it("refetches when the country changes", async () => {
    const { calendar, service, setCountry, repos } = setup();
    calendar.setHolidays(CA, CA_HOLIDAYS).setHolidays(COUNTRY_HOLIDAY_CALENDARS.US!, [{ date: "2025-07-04", name: "Independence Day" }]);
    await service.refreshIfStale();
    setCountry("US");
    await service.refreshIfStale();
    expect((await repos.holidays.get())?.country).toBe("US");
    expect(await service.dates()).toEqual(["2025-07-04"]);
  });

  it("refetches when the year rolls over even inside 7 days, asking for the new year and the next", async () => {
    const { calendar, clock, service } = setup({ now: Date.parse("2025-12-30T15:00:00Z") });
    calendar.setHolidays(CA, CA_HOLIDAYS);
    await service.refreshIfStale();
    clock.set(Date.parse("2026-01-02T15:00:00Z"));
    await service.refreshIfStale();
    expect(calendar.opLog()).toEqual(["readHolidays", "readHolidays"]);
  });

  it("requests [Jan 1 of this year, Jan 1 two years on)", async () => {
    const asked: string[][] = [];
    const repos = new Repositories(new MemoryKeyValueStore());
    const service = new HolidayService({
      repos,
      clock: new FakeClock(T0),
      country: () => "CA",
      calendar: {
        readHolidays: async (id, min, max) => {
          asked.push([id, min, max]);
          return CA_HOLIDAYS;
        },
      },
    });
    await service.refreshIfStale();
    expect(asked).toEqual([[CA, "2025-01-01T00:00:00Z", "2027-01-01T00:00:00Z"]]);
  });

  it("keeps the old cache and does not throw when the read fails", async () => {
    const { repos, calendar, clock, service } = setup();
    calendar.setHolidays(CA, CA_HOLIDAYS);
    await service.refreshIfStale();
    clock.advance(8 * DAY);
    calendar.failAll({ kind: "network" });
    await expect(service.refreshIfStale()).resolves.toBeUndefined();
    expect((await repos.holidays.get())?.items).toEqual(CA_HOLIDAYS);
    expect((await repos.holidays.get())?.fetchedAt).toBe(T0);
    expect(await service.dates()).toEqual(["2025-07-01", "2025-12-25", "2026-01-01"]);
  });

  it("keeps a non-empty cache when the calendar later reads as empty (403/404)", async () => {
    const { repos, calendar, clock, service } = setup();
    calendar.setHolidays(CA, CA_HOLIDAYS);
    await service.refreshIfStale();
    clock.advance(8 * DAY);
    calendar.setHolidays(CA, []);
    await service.refreshIfStale();
    expect((await repos.holidays.get())?.items).toHaveLength(3);
  });

  it("does nothing for an unmapped country", async () => {
    const { repos, calendar, service } = setup({ country: "XX" });
    await service.refreshIfStale();
    expect(calendar.calls).toEqual([]);
    expect(await repos.holidays.get()).toBeNull();
  });
});

describe("HolidayService reads", () => {
  it("dates() is empty before any fetch and sorted/unique after", async () => {
    const { calendar, service } = setup();
    expect(await service.dates()).toEqual([]);
    calendar.setHolidays(CA, [...CA_HOLIDAYS, { date: "2025-07-01", name: "Canada Day (obs.)" }]);
    await service.refreshIfStale();
    expect(await service.dates()).toEqual(["2025-07-01", "2025-12-25", "2026-01-01"]);
  });

  it("holidayNameFor returns the name or undefined", async () => {
    const { calendar, service } = setup();
    calendar.setHolidays(CA, CA_HOLIDAYS);
    await service.refreshIfStale();
    expect(await service.holidayNameFor("2025-12-25")).toBe("Christmas Day");
    expect(await service.holidayNameFor("2025-12-26")).toBeUndefined();
  });

  it("summary is null before the first fetch", async () => {
    expect(await setup().service.summary()).toBeNull();
  });

  it("summary names the country and the next holiday, counting today", async () => {
    const { calendar, clock, service } = setup();
    calendar.setHolidays(CA, CA_HOLIDAYS);
    await service.refreshIfStale();
    expect(await service.summary()).toEqual({ country: "Canada", next: { name: "Canada Day", date: "2025-07-01" } });
    // July 1, 10:00 Toronto is still "today".
    clock.set(Date.parse("2025-07-01T14:00:00Z"));
    expect((await service.summary())?.next?.date).toBe("2025-07-01");
    clock.set(Date.parse("2025-07-02T14:00:00Z"));
    expect((await service.summary())?.next?.date).toBe("2025-12-25");
  });

  it("summary crosses the year end and omits next when none is left", async () => {
    const { calendar, clock, service } = setup({ now: Date.parse("2025-12-20T15:00:00Z") });
    calendar.setHolidays(CA, CA_HOLIDAYS);
    await service.refreshIfStale();
    clock.set(Date.parse("2025-12-26T15:00:00Z"));
    expect((await service.summary())?.next).toEqual({ name: "New Year's Day", date: "2026-01-01" });
    clock.set(Date.parse("2026-01-02T15:00:00Z"));
    expect(await service.summary()).toEqual({ country: "Canada" });
  });

  it("Toronto evening before midnight UTC still counts as that day", async () => {
    const { calendar, clock, service } = setup();
    calendar.setHolidays(CA, CA_HOLIDAYS);
    await service.refreshIfStale();
    // 2025-12-25 21:00 Toronto = 2025-12-26 02:00Z
    clock.set(Date.parse("2025-12-26T02:00:00Z"));
    expect((await service.summary())?.next?.date).toBe("2025-12-25");
  });
});

describe("allHolidays", () => {
  it("returns settings holidays without a source", async () => {
    expect(await allHolidays(["2025-01-01"])).toEqual(["2025-01-01"]);
  });
  it("unions and dedupes, and survives a failing source", async () => {
    expect(await allHolidays(["2025-01-01"], { dates: async () => ["2025-01-01", "2025-02-02"] })).toEqual([
      "2025-01-01",
      "2025-02-02",
    ]);
    expect(
      await allHolidays(["2025-01-01"], {
        dates: async () => {
          throw new Error("x");
        },
      }),
    ).toEqual(["2025-01-01"]);
  });
});

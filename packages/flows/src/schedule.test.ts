import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { torontoInstant } from "@timeblocker/scheduling-engine";
import { extractSchedule, scheduleToEngineFields } from "./schedule.js";
import { validateIntakeInput } from "./intake.js";
import { estimateCandidate } from "./estimate.js";

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  torontoInstant(y, mo, d, h, mi).getTime();
const iso = (y: number, mo: number, d: number, h = 0, mi = 0): string =>
  torontoInstant(y, mo, d, h, mi).toISOString();

// Friday 2026-11-06 10:00 Toronto.
const NOW = at(2026, 11, 6, 10, 0);
// Sunday 2026-11-08 10:00 Toronto.
const SUNDAY = at(2026, 11, 8, 10, 0);

describe("extractSchedule: fixed start (R28.1, R28.2)", () => {
  it("Dentist Tuesday 3pm", () => {
    const r = extractSchedule("Dentist Tuesday 3pm", NOW);
    expect(r).toEqual({ title: "Dentist", fixedStart: iso(2026, 11, 10, 15), notes: [] });
  });
  it("Dentist tue 3:30 pm", () => {
    const r = extractSchedule("Dentist tue 3:30 pm", NOW);
    expect(r.title).toBe("Dentist");
    expect(r.fixedStart).toBe(iso(2026, 11, 10, 15, 30));
  });
  it("24h and noon", () => {
    expect(extractSchedule("Sync tomorrow 15:00", NOW).fixedStart).toBe(iso(2026, 11, 7, 15));
    expect(extractSchedule("Lunch tomorrow noon", NOW).fixedStart).toBe(iso(2026, 11, 7, 12));
  });
  it("Lunch today 12:30", () => {
    const r = extractSchedule("Lunch today 12:30", NOW);
    expect(r.title).toBe("Lunch");
    expect(r.fixedStart).toBe(iso(2026, 11, 6, 12, 30));
  });
  it("Call mom at 7pm (time only, ahead -> today)", () => {
    const r = extractSchedule("Call mom at 7pm", NOW);
    expect(r.title).toBe("Call mom");
    expect(r.fixedStart).toBe(iso(2026, 11, 6, 19));
  });
  it("time already passed today -> tomorrow", () => {
    const r = extractSchedule("Call mom at 9am", NOW);
    expect(r.fixedStart).toBe(iso(2026, 11, 7, 9));
  });
  it("a bare 'at 7' is not a time", () => {
    expect(extractSchedule("Call mom at 7", NOW)).toEqual({ title: "Call mom at 7", notes: [] });
  });
  it("Gym tomorrow 6-7pm gives start and duration", () => {
    const r = extractSchedule("Gym tomorrow 6-7pm", NOW);
    expect(r.title).toBe("Gym");
    expect(r.fixedStart).toBe(iso(2026, 11, 7, 18));
    expect(r.durationMin).toBe(60);
  });
  it("Standup 9:00-9:15 Monday", () => {
    const r = extractSchedule("Standup 9:00-9:15 Monday", NOW);
    expect(r.title).toBe("Standup");
    expect(r.fixedStart).toBe(iso(2026, 11, 9, 9));
    expect(r.durationMin).toBe(15);
  });
  it("range forms with 'to' and 'from'", () => {
    expect(extractSchedule("Class monday 9am to 10am", NOW).durationMin).toBe(60);
    const r = extractSchedule("Meet monday from 3 to 4pm", NOW);
    expect(r.title).toBe("Meet");
    expect(r.fixedStart).toBe(iso(2026, 11, 9, 15));
  });
  it("a lone time range without a day is left to the duration extractor", () => {
    expect(extractSchedule("Study 3-4pm", NOW)).toEqual({ title: "Study 3-4pm", notes: [] });
    const c = estimateCandidate({ text: "Study 3-4pm" }, [], [], NOW);
    expect(c.durationMin).toBe(60);
    expect(c.fixedStart).toBeUndefined();
  });
});

describe("extractSchedule: days and weekdays (R28.1, R28.3)", () => {
  it("tonight defaults to 19:00", () => {
    const r = extractSchedule("Call mom tonight", NOW);
    expect(r.title).toBe("Call mom");
    expect(r.fixedStart).toBe(iso(2026, 11, 6, 19));
  });
  it("tonight after 19:00 becomes onDay today", () => {
    const r = extractSchedule("Call mom tonight", at(2026, 11, 6, 20));
    expect(r.onDay).toBe("2026-11-06");
    expect(r.fixedStart).toBeUndefined();
  });
  it("day only -> onDay", () => {
    expect(extractSchedule("Clean garage tomorrow", NOW)).toEqual({
      title: "Clean garage",
      onDay: "2026-11-07",
      notes: [],
    });
  });
  it("monday vs next monday (from Friday)", () => {
    // "next" = the following Sunday-Saturday week; from Friday that is also
    // the next calendar Monday. They differ on a Sunday (see below).
    expect(extractSchedule("Plan monday", NOW).onDay).toBe("2026-11-09");
    expect(extractSchedule("Plan next monday", NOW).onDay).toBe("2026-11-09");
    expect(extractSchedule("Plan next friday", NOW).onDay).toBe("2026-11-13");
    expect(extractSchedule("Plan this friday", NOW).onDay).toBe("2026-11-06");
    expect(extractSchedule("Plan on fri", NOW).onDay).toBe("2026-11-06");
  });
  it("today's weekday with a passed time means next week", () => {
    expect(extractSchedule("Review fri 9am", NOW).fixedStart).toBe(iso(2026, 11, 13, 9));
    expect(extractSchedule("Review fri 3pm", NOW).fixedStart).toBe(iso(2026, 11, 6, 15));
  });
  it("from a Sunday", () => {
    expect(extractSchedule("Plan monday", SUNDAY).onDay).toBe("2026-11-09");
    expect(extractSchedule("Plan next monday", SUNDAY).onDay).toBe("2026-11-16");
    expect(extractSchedule("Plan sunday", SUNDAY).onDay).toBe("2026-11-08");
  });
  it("Sunday school parses as onDay Sunday (documented)", () => {
    const r = extractSchedule("Sunday school", NOW);
    expect(r.onDay).toBe("2026-11-08");
  });
});

describe("extractSchedule: dates (R28.1, R28.7)", () => {
  it("date forms", () => {
    for (const t of ["Trip Nov 12", "Trip November 12th", "Trip 12 Nov", "Trip 12th of November", "Trip 2026-11-12", "Trip 11/12"]) {
      const r = extractSchedule(t, NOW);
      expect(r.onDay, t).toBe("2026-11-12");
      expect(r.title, t).toBe("Trip");
    }
    expect(extractSchedule("Trip 11/12/2027", NOW).onDay).toBe("2027-11-12");
  });
  it("date + time is a fixed start", () => {
    expect(extractSchedule("Dinner Nov 12 7pm", NOW).fixedStart).toBe(iso(2026, 11, 12, 19));
  });
  it("past date is ignored with a note (title still cleaned)", () => {
    const r = extractSchedule("Taxes Nov 1", NOW);
    expect(r.onDay).toBeUndefined();
    expect(r.fixedStart).toBeUndefined();
    expect(r.notes).toEqual(["Date in the past was ignored"]);
    expect(r.title).toBe("Taxes");
    expect(extractSchedule("Taxes 2025-01-05", NOW).notes).toEqual(["Date in the past was ignored"]);
  });
  it("year-less date more than 60 days in the past rolls to next year", () => {
    expect(extractSchedule("Taxes Jan 5", NOW).onDay).toBe("2027-01-05");
    expect(extractSchedule("Taxes Aug 1", NOW).onDay).toBe("2027-08-01");
    // exactly within 60 days stays in the past
    expect(extractSchedule("Taxes Sep 20", NOW).notes).toEqual(["Date in the past was ignored"]);
  });
});

describe("extractSchedule: deadlines (R28.5)", () => {
  it("Submit report by Friday 5pm", () => {
    const r = extractSchedule("Submit report by Friday 5pm", NOW);
    expect(r.title).toBe("Submit report");
    expect(r.dueAt).toBe(iso(2026, 11, 6, 17));
    expect(r.fixedStart).toBeUndefined();
  });
  it("Application due Nov 20 -> 17:00", () => {
    const r = extractSchedule("Application due Nov 20", NOW);
    expect(r.title).toBe("Application");
    expect(r.dueAt).toBe(iso(2026, 11, 20, 17));
  });
  it("Report due 2026-11-12 noon", () => {
    const r = extractSchedule("Report due 2026-11-12 noon", NOW);
    expect(r.title).toBe("Report");
    expect(r.dueAt).toBe(iso(2026, 11, 12, 12));
  });
  it("Pay invoice before Thursday", () => {
    const r = extractSchedule("Pay invoice before Thursday", NOW);
    expect(r.title).toBe("Pay invoice");
    expect(r.dueAt).toBe(iso(2026, 11, 12, 17));
  });
  it("other deadline words", () => {
    expect(extractSchedule("Essay no later than monday", NOW).dueAt).toBe(iso(2026, 11, 9, 17));
    expect(extractSchedule("Essay until tomorrow", NOW).dueAt).toBe(iso(2026, 11, 7, 17));
    expect(extractSchedule("Essay deadline Nov 20", NOW).dueAt).toBe(iso(2026, 11, 20, 17));
    expect(extractSchedule("Essay due on Nov 20", NOW).title).toBe("Essay");
  });
  it("time-only deadline: today if ahead, else tomorrow", () => {
    expect(extractSchedule("Send file by 3pm", NOW).dueAt).toBe(iso(2026, 11, 6, 15));
    expect(extractSchedule("Send file by 9am", NOW).dueAt).toBe(iso(2026, 11, 7, 9));
  });
  it("eod and eow", () => {
    expect(extractSchedule("Wrap up eod", NOW)).toMatchObject({ title: "Wrap up", dueAt: iso(2026, 11, 6, 17) });
    expect(extractSchedule("Wrap up eow", NOW).dueAt).toBe(iso(2026, 11, 6, 17));
    // Sunday: this week's Friday is the 13th? No: Sun 11-08 -> Fri 11-13.
    expect(extractSchedule("Wrap up eow", SUNDAY).dueAt).toBe(iso(2026, 11, 13, 17));
  });
  it("a deadline in the past is ignored with a note", () => {
    const r = extractSchedule("Report by 9am today", NOW);
    expect(r.dueAt).toBeUndefined();
    expect(r.notes).toEqual(["Deadline in the past was ignored"]);
    expect(r.title).toBe("Report");
  });
  it("'by' followed by non-date text is not a deadline", () => {
    for (const t of ["Wash by hand", "Meet by the pool"]) {
      expect(extractSchedule(t, NOW)).toEqual({ title: t, notes: [] });
    }
  });
});

describe("extractSchedule: negatives", () => {
  it.each([
    "Call 3 people",
    "Chapter 2",
    "Q3 report",
    "Top 5 tasks",
    "Study session 2-3",
    "Pay rent on the 1st",
    "march to the beat",
    "Read 1/2 hour",
  ])("%s is untouched", (t) => {
    expect(extractSchedule(t, NOW)).toEqual({ title: t, notes: [] });
  });
  it("never yields an empty title", () => {
    expect(extractSchedule("tomorrow 3pm", NOW)).toEqual({ title: "tomorrow 3pm", notes: [] });
    expect(extractSchedule("", NOW).title).toBe("");
  });
});

describe("extractSchedule: DST", () => {
  it("handles the fall-back day (2026-11-01 is 25 hours long)", () => {
    const now = at(2026, 10, 31, 10);
    const r = extractSchedule("Walk tomorrow 3pm", now);
    expect(r.fixedStart).toBe(iso(2026, 11, 1, 15)); // EST, 20:00Z
    expect(r.fixedStart).toBe("2026-11-01T20:00:00.000Z");
    expect(extractSchedule("Walk today 3pm", now).fixedStart).toBe("2026-10-31T19:00:00.000Z");
    const across = extractSchedule("Walk monday", at(2026, 11, 1, 1, 30));
    expect(across.onDay).toBe("2026-11-02");
  });
});

describe("scheduleToEngineFields", () => {
  it("maps fixedStart, onDay and dueAt", () => {
    const f = scheduleToEngineFields({ fixedStart: iso(2026, 11, 9, 9), onDay: "2026-11-01", dueAt: iso(2026, 11, 1, 12) });
    expect(f.fixedStartMs).toBe(at(2026, 11, 9, 9));
    expect(f.earliestMs).toBe(at(2026, 11, 1, 0));
    expect(f.latestEndMs).toBe(at(2026, 11, 1, 12)); // deadline is earlier than the day end
  });
  it("ignores invalid values", () => {
    expect(scheduleToEngineFields({ fixedStart: "x", onDay: "2026-13-40", dueAt: "nope" })).toEqual({});
  });
});

describe("intake plumbing (R28.6)", () => {
  const run = (raw: string, now = NOW) => {
    const r = validateIntakeInput(raw, undefined, now);
    if (!r.ok) throw new Error(r.reason);
    return r.candidates;
  };

  it("fixed start with a stated duration from a range", () => {
    const [c] = run("Gym tomorrow 6-7pm");
    expect(c).toMatchObject({ text: "Gym", fixedStart: iso(2026, 11, 7, 18), durationMin: 60, count: 1 });
    expect(c!.source?.duration).toBe("stated");
  });
  it("count + fixed time drops the fixed time with a note, keeps deadline", () => {
    const [a] = run("Run 3x tomorrow 7am");
    expect(a!.count).toBe(3);
    expect(a!.fixedStart).toBeUndefined();
    expect(a!.onDay).toBeUndefined();
    expect(a!.scheduleNotes).toContain("Fixed time ignored for repeated tasks");
    const [b] = run("Study 3x by Friday 5pm");
    expect(b).toMatchObject({ count: 3, dueAt: iso(2026, 11, 6, 17), priority: 1 });
  });
  it("deadline items get priority 1, even when another is stated", () => {
    const [c] = run("Report due Nov 20 | 60 | 4 | work");
    expect(c).toMatchObject({ text: "Report", priority: 1, dueAt: iso(2026, 11, 20, 17), durationMin: 60 });
  });
  it("duration stated in text still wins over a schedule-less range", () => {
    const [c] = run("Dentist Tuesday 3pm 45 min");
    expect(c).toMatchObject({ text: "Dentist", durationMin: 45, fixedStart: iso(2026, 11, 10, 15) });
  });
  it("notes carry through for past dates", () => {
    const [c] = run("Taxes Nov 1");
    expect(c!.scheduleNotes).toEqual(["Date in the past was ignored"]);
  });
  it("pipe form accepts and validates schedule fields", () => {
    const [c] = run("Dentist | 30 | 2 | misc | | 2026-11-10T20:00:00Z | | ");
    expect(c!.fixedStart).toBe("2026-11-10T20:00:00.000Z");
    const [d] = run("Trip | | | | | | 2026-11-12 | 2026-11-13T22:00:00Z");
    expect(d).toMatchObject({ onDay: "2026-11-12", dueAt: "2026-11-13T22:00:00.000Z", priority: 1 });
    const [e] = run("Trip | | | | | garbage | 2026-02-31 | nope");
    expect(e!.fixedStart).toBeUndefined();
    expect(e!.onDay).toBeUndefined();
    expect(e!.dueAt).toBeUndefined();
  });
  it("JSON form accepts schedule fields", () => {
    const [c] = run(
      JSON.stringify([{ text: "Dentist", fixedStart: "2026-11-10T20:00:00Z", onDay: "2026-11-10", dueAt: "bad" }]),
    );
    expect(c!.fixedStart).toBe("2026-11-10T20:00:00.000Z");
    expect(c!.dueAt).toBeUndefined();
  });
  it("estimateCandidate without nowMs does not parse schedule text", () => {
    const c = estimateCandidate({ text: "Dentist Tuesday 3pm" }, [], []);
    expect(c.text).toBe("Dentist Tuesday 3pm");
    expect(c.fixedStart).toBeUndefined();
  });
});

describe("Property 34", () => {
  // Feature: timeblocker, Property 34: Schedule extraction never yields an empty title and every ISO field is valid
  const words = [
    "call", "mom", "report", "gym", "tomorrow", "today", "tonight", "monday", "fri", "next",
    "this", "on", "at", "by", "due", "before", "3pm", "15:30", "noon", "Nov", "12", "12th",
    "2026-11-12", "11/12", "6-7pm", "9:00-10:15", "eod", "eow", "the", "1st", "@", "-", ",",
  ];
  it("holds for arbitrary lines and clocks", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...words), { minLength: 1, maxLength: 7 }),
        fc.integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2028, 0, 1) }),
        (parts, now) => {
          const text = parts.join(" ");
          const r = extractSchedule(text, now);
          expect(r.title.trim().length > 0 || text.trim().length === 0).toBe(true);
          for (const f of [r.fixedStart, r.dueAt]) {
            if (f !== undefined) {
              expect(Number.isNaN(Date.parse(f))).toBe(false);
              expect(new Date(f).toISOString()).toBe(f);
            }
          }
          if (r.onDay !== undefined) {
            expect(r.onDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(Number.isNaN(Date.parse(r.onDay))).toBe(false);
          }
          if (r.dueAt !== undefined) expect(Date.parse(r.dueAt)).toBeGreaterThan(now);
          if (r.durationMin !== undefined) expect(r.durationMin).toBeGreaterThan(0);
        },
      ),
      { numRuns: 300 },
    );
  });
});

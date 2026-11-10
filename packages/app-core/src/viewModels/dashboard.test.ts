import type { Category } from "@timeblocker/scheduling-engine";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DeviceBlock, DeviceBlockStatus, SleepScore } from "../models.js";
import { buildDashboard, greeting, type DashboardInput } from "./dashboard.js";
import {
  MOTIVATION_MESSAGES,
  motivationMessage,
  progressBucket,
  type Progress,
} from "./motivation.js";

const NOW = Date.parse("2025-03-11T15:00:00Z"); // Tue 11:00 EDT
const WEEK = "2025-03-09";
const PROGRESS: Progress[] = [
  "none",
  "just-started",
  "going-well",
  "nearly-done",
  "all-done",
  "behind",
];

let seq = 0;
function block(
  status: DeviceBlockStatus,
  extra: Partial<DeviceBlock> & { category?: Category } = {},
): DeviceBlock {
  seq += 1;
  return {
    id: `b${seq}`,
    itemId: `i${seq}`,
    title: `Block ${seq}`,
    start: "2025-03-12T14:00:00Z",
    end: "2025-03-12T15:00:00Z",
    category: "work",
    status,
    weekId: WEEK,
    calendarEventId: `evt${seq}0000`,
    calendarSynced: true,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: 0,
    ...extra,
  };
}

const night = (
  dateKey: string,
  score: number,
  source: SleepScore["source"] = "usage",
): SleepScore => ({
  dateKey,
  usageMin: 0,
  score,
  scoredAt: 0,
  source,
});

function dash(over: Partial<DashboardInput> = {}) {
  return buildDashboard({
    now: NOW,
    weekId: WEEK,
    blocks: [],
    sleepScores: [],
    usageStatus: "granted",
    ...over,
  });
}

const widgetOf = (v: ReturnType<typeof dash>, id: string) => v.widgets.find((w) => w.id === id)!;

describe("progressBucket", () => {
  it("none when there is nothing planned", () => {
    expect(progressBucket({ total: 0, done: 0, endedUnfinished: 0, weekday: 1 })).toBe("none");
  });
  it("all-done when done equals total", () => {
    expect(progressBucket({ total: 5, done: 5, endedUnfinished: 0, weekday: 1 })).toBe("all-done");
  });
  it("nearly-done at 80% and not below", () => {
    expect(progressBucket({ total: 10, done: 8, endedUnfinished: 0, weekday: 1 })).toBe("nearly-done");
    expect(progressBucket({ total: 10, done: 9, endedUnfinished: 0, weekday: 1 })).toBe("nearly-done");
    expect(progressBucket({ total: 10, done: 7, endedUnfinished: 0, weekday: 1 })).toBe("going-well");
  });
  it("nearly-done wins over behind", () => {
    expect(progressBucket({ total: 10, done: 8, endedUnfinished: 2, weekday: 1 })).toBe("nearly-done");
  });
  it("behind at 40% ended-unfinished and not below", () => {
    expect(progressBucket({ total: 10, done: 3, endedUnfinished: 4, weekday: 1 })).toBe("behind");
    expect(progressBucket({ total: 10, done: 3, endedUnfinished: 3, weekday: 1 })).toBe("just-started");
  });
  it("behind wins over going-well", () => {
    expect(progressBucket({ total: 10, done: 5, endedUnfinished: 4, weekday: 1 })).toBe("behind");
  });
  it("going-well at 40% done and not below", () => {
    expect(progressBucket({ total: 10, done: 4, endedUnfinished: 0, weekday: 1 })).toBe("going-well");
    expect(progressBucket({ total: 10, done: 3, endedUnfinished: 0, weekday: 1 })).toBe("just-started");
  });
  it("just-started otherwise, including zero done", () => {
    expect(progressBucket({ total: 10, done: 0, endedUnfinished: 0, weekday: 1 })).toBe("just-started");
    expect(progressBucket({ total: 1, done: 0, endedUnfinished: 0, weekday: 1 })).toBe("just-started");
  });
});

describe("motivationMessage", () => {
  it("has at least 5 distinct, plain, non-empty messages per bucket", () => {
    for (const p of PROGRESS) {
      const list = MOTIVATION_MESSAGES[p];
      expect(list.length).toBeGreaterThanOrEqual(5);
      expect(new Set(list).size).toBe(list.length);
      for (const m of list) {
        expect(m.trim()).not.toBe("");
        expect((m.match(/!/g) ?? []).length).toBeLessThanOrEqual(1);
        expect(m).not.toMatch(/\p{Extended_Pictographic}/u);
      }
    }
  });

  it("is deterministic for the same day", () => {
    for (const p of PROGRESS) {
      const a = motivationMessage({ progress: p, weekday: 2, dateKey: "2025-03-11" });
      const b = motivationMessage({ progress: p, weekday: 2, dateKey: "2025-03-11" });
      expect(a).toBe(b);
      expect(a).not.toBe("");
    }
  });

  it("changes from day to day, including across month and year ends", () => {
    for (const p of PROGRESS) {
      for (const [a, b] of [
        ["2025-03-11", "2025-03-12"],
        ["2025-03-31", "2025-04-01"],
        ["2025-12-31", "2026-01-01"],
      ] as const) {
        expect(motivationMessage({ progress: p, weekday: 0, dateKey: a })).not.toBe(
          motivationMessage({ progress: p, weekday: 0, dateKey: b }),
        );
      }
    }
  });

  it("rotates by weekday when no dateKey is given", () => {
    for (const p of PROGRESS) {
      const seen = new Set<string>();
      for (let wd = 0; wd < 7; wd++) seen.add(motivationMessage({ progress: p, weekday: wd }));
      expect(seen.size).toBe(7);
    }
  });

  it("falls back to weekday for a malformed dateKey", () => {
    expect(motivationMessage({ progress: "behind", weekday: 3, dateKey: "nope" })).toBe(
      motivationMessage({ progress: "behind", weekday: 3 }),
    );
  });
});

describe("greeting", () => {
  it("uses a trimmed given name", () => {
    expect(greeting("Rucha")).toBe("Hi Rucha!");
    expect(greeting("  Rucha  ")).toBe("Hi Rucha!");
  });
  it("falls back for missing or blank names", () => {
    expect(greeting(undefined)).toBe("Hi there!");
    expect(greeting(null)).toBe("Hi there!");
    expect(greeting("")).toBe("Hi there!");
    expect(greeting("   ")).toBe("Hi there!");
    expect(dash({ givenName: "Sam" }).greeting).toBe("Hi Sam!");
    expect(dash().greeting).toBe("Hi there!");
    expect(dash({ givenName: "Sam" }).hasName).toBe(true);
    expect(dash().hasName).toBe(false);
    expect(dash({ givenName: "   " }).hasName).toBe(false);
    expect(dash({ givenName: null }).hasName).toBe(false);
  });
});

describe("buildDashboard great flags", () => {
  const tasksOf = (done: number, total: number) =>
    widgetOf(
      dash({
        blocks: [
          ...Array.from({ length: done }, () => block("done")),
          ...Array.from({ length: total - done }, () => block("scheduled")),
        ],
      }),
      "tasks",
    );
  it("tasks are great at 75% and above only", () => {
    expect(tasksOf(3, 4).great).toBe(true);
    expect(tasksOf(2, 3).great).toBe(false); // 67%
    expect(tasksOf(0, 0).great).toBe(false); // no data
  });
  it("fitness is great at 75% and above only", () => {
    const fit = (done: number, total: number) =>
      widgetOf(
        dash({
          blocks: [
            ...Array.from({ length: done }, () => block("done", { category: "fitness" })),
            ...Array.from({ length: total - done }, () => block("scheduled", { category: "fitness" })),
          ],
        }),
        "fitness",
      );
    expect(fit(3, 4).great).toBe(true);
    expect(fit(1, 2).great).toBe(false);
    expect(widgetOf(dash(), "fitness").great).toBe(false);
  });
  it("sleep is great at an average of 80 (8.0) and above only", () => {
    expect(widgetOf(dash({ sleepScores: [night("a", 80)] }), "sleep").great).toBe(true);
    expect(widgetOf(dash({ sleepScores: [night("a", 79)] }), "sleep").great).toBe(false);
    expect(widgetOf(dash(), "sleep").great).toBe(false);
  });
  it("moved is never great", () => {
    const moved = Array.from({ length: 5 }, () =>
      block("scheduled", { movedFrom: { start: "2025-03-10T14:00:00Z", end: "2025-03-10T15:00:00Z" } }),
    );
    expect(widgetOf(dash({ blocks: moved }), "moved").great).toBe(false);
  });
});
describe("buildDashboard widgets", () => {
  it("returns four widgets in order with labels and a11y labels", () => {
    const v = dash({ blocks: [block("done"), block("scheduled")] });
    expect(v.widgets.map((w) => w.id)).toEqual(["tasks", "sleep", "fitness", "moved"]);
    expect(v.widgets.map((w) => w.label)).toEqual([
      "Tasks completed",
      "Sleep score",
      "Fitness score",
      "Moved tasks",
    ]);
    for (const w of v.widgets) {
      expect(w.a11yLabel).toBe(`${w.label}: ${w.value}. ${w.caption}${w.sourceLine ? `. ${w.sourceLine}` : ""}`);
    }
    expect(v.widgets.map((w) => w.icon)).toEqual(["check", "moon", "run", "double-arrow"]);
    expect(v.important).toEqual({ rows: [], moreCount: 0 });
  });

  describe("tasks", () => {
    it("shows a dash when nothing is planned", () => {
      const w = widgetOf(dash(), "tasks");
      expect(w.value).toBe("—");
      expect(w.caption).toBe("No tasks planned yet");
      expect(dash().progress).toBe("none");
    });
    it("shows done out of all blocks except rolled", () => {
      const blocks = [
        ...Array.from({ length: 4 }, () => block("done")),
        ...Array.from({ length: 4 }, () => block("scheduled")),
        block("missed"),
        block("rolled"),
        block("rolled"),
      ];
      const w = widgetOf(dash({ blocks }), "tasks");
      expect(w.value).toBe("44%");
      expect(w.caption).toBe("4 of 9 done");
    });
    it("shows a dash when only rolled blocks exist", () => {
      expect(widgetOf(dash({ blocks: [block("rolled")] }), "tasks").value).toBe("—");
    });
    it("counts partial and skipped in the denominator but not as done", () => {
      const w = widgetOf(dash({ blocks: [block("done"), block("partial"), block("skipped")] }), "tasks");
      expect(w.value).toBe("33%");
    });
    it("is 100% when all are done", () => {
      expect(widgetOf(dash({ blocks: [block("done")] }), "tasks").value).toBe("100%");
    });
  });

  describe("sleep", () => {
    it("averages the scores and shows them on a 0-10 scale with one decimal", () => {
      const w = widgetOf(dash({ sleepScores: [night("a", 100), night("b", 85), night("c", 70)] }), "sleep");
      expect(w.value).toBe("8.5");
      expect(w.caption).toBe("Average of 3 nights");
      expect(w.sourceLine).toBe("Phone use only");
      expect(widgetOf(dash({ sleepScores: [night("a", 91)] }), "sleep").caption).toBe("Average of 1 night");
      expect(widgetOf(dash({ sleepScores: [night("a", 90), night("b", 85)] }), "sleep").value).toBe("8.8");
      expect(widgetOf(dash({ sleepScores: [night("a", 74)] }), "sleep").value).toBe("7.4");
      expect(widgetOf(dash({ sleepScores: [night("a", 100)] }), "sleep").value).toBe("10.0");
    });
    it("names Samsung Health on the source line when any counted night used it", () => {
      const all = widgetOf(
        dash({ sleepScores: [night("a", 90, "health+usage"), night("b", 80, "health+usage")] }),
        "sleep",
      );
      expect(all.caption).toBe("Average of 2 nights");
      expect(all.sourceLine).toBe("Samsung Health + phone use");
      expect(all.a11yLabel).toBe("Sleep score: 8.5. Average of 2 nights. Samsung Health + phone use");
      const mixed = widgetOf(dash({ sleepScores: [night("a", 90, "health+usage"), night("b", 80)] }), "sleep");
      expect(mixed.sourceLine).toBe("Samsung Health + phone use");
      const none = widgetOf(dash({ sleepScores: [night("a", 90)] }), "sleep");
      expect(none.a11yLabel).toBe("Sleep score: 9.0. Average of 1 night. Phone use only");
    });
    it("shows a usage access reason when denied", () => {
      const w = widgetOf(dash({ usageStatus: "denied" }), "sleep");
      expect(w.value).toBe("—");
      expect(w.caption).toBe("Allow usage access to see this");
    });
    it("shows no nights recorded when granted or unknown", () => {
      for (const usageStatus of ["granted", "unknown"] as const) {
        const w = widgetOf(dash({ usageStatus }), "sleep");
        expect(w.value).toBe("—");
        expect(w.caption).toBe("No nights recorded yet");
      }
    });
    it("shows scores even when usage is now denied", () => {
      expect(widgetOf(dash({ usageStatus: "denied", sleepScores: [night("a", 0)] }), "sleep").value).toBe("0.0");
    });
  });

  describe("fitness", () => {
    it("shows a dash when there are no fitness blocks", () => {
      const w = widgetOf(dash({ blocks: [block("done")] }), "fitness");
      expect(w.value).toBe("—");
      expect(w.caption).toBe("No fitness tasks this week");
    });
    it("computes done fitness over all fitness blocks", () => {
      const blocks = [
        block("done", { category: "fitness" }),
        block("done", { category: "fitness" }),
        block("scheduled", { category: "fitness" }),
        block("done"),
      ];
      const w = widgetOf(dash({ blocks }), "fitness");
      expect(w.value).toBe("67%");
      expect(w.caption).toBe("2 of 3 fitness tasks");
    });
    it("uses singular for one fitness task and ignores rolled", () => {
      const blocks = [block("done", { category: "fitness" }), block("rolled", { category: "fitness" })];
      const w = widgetOf(dash({ blocks }), "fitness");
      expect(w.value).toBe("100%");
      expect(w.caption).toBe("1 of 1 fitness task");
    });
  });

  describe("moved", () => {
    const span = { start: "2025-03-10T14:00:00Z", end: "2025-03-10T15:00:00Z" };
    it("is 0 with a plural caption when nothing moved", () => {
      const w = widgetOf(dash({ blocks: [block("scheduled")] }), "moved");
      expect(w.value).toBe("0");
      expect(w.caption).toBe("moved to new slots");
    });
    it("counts movedFrom and rolled blocks, a rolled moved block once", () => {
      const blocks = [
        block("scheduled", { movedFrom: span }),
        block("rolled"),
        block("rolled", { movedFrom: span }),
        block("done"),
      ];
      const w = widgetOf(dash({ blocks }), "moved");
      expect(w.value).toBe("3");
      expect(w.caption).toBe("moved to new slots");
    });
    it("uses a singular caption for one", () => {
      const w = widgetOf(dash({ blocks: [block("rolled")] }), "moved");
      expect(w.value).toBe("1");
      expect(w.caption).toBe("moved to a new slot");
    });
  });
});

describe("buildDashboard progress and message", () => {
  it("counts ended unfinished blocks (missed, skipped, past-due scheduled) toward behind", () => {
    const blocks = [
      block("missed"),
      block("skipped"),
      block("scheduled", { end: "2025-03-10T15:00:00Z" }), // already ended
      block("scheduled"),
      block("scheduled"),
    ];
    expect(dash({ blocks }).progress).toBe("behind");
  });
  it("reports going-well, nearly-done and all-done", () => {
    const pending = (n: number) => Array.from({ length: n }, () => block("scheduled"));
    const done = (n: number) => Array.from({ length: n }, () => block("done"));
    expect(dash({ blocks: [...done(5), ...pending(5)] }).progress).toBe("going-well");
    expect(dash({ blocks: [...done(9), ...pending(1)] }).progress).toBe("nearly-done");
    expect(dash({ blocks: done(3) }).progress).toBe("all-done");
    expect(dash({ blocks: [...done(1), ...pending(9)] }).progress).toBe("just-started");
  });
  it("uses the Toronto date: same message all day, different the next day", () => {
    const blocks = [block("scheduled")];
    const morning = dash({ blocks, now: Date.parse("2025-03-11T11:00:00Z") }).message; // 07:00 EDT
    const night = dash({ blocks, now: Date.parse("2025-03-12T01:30:00Z") }).message; // 21:30 EDT same day
    const next = dash({ blocks, now: Date.parse("2025-03-12T15:00:00Z") }).message;
    expect(morning).toBe(night);
    expect(next).not.toBe(morning);
    expect(morning).not.toBe("");
  });
});

describe("properties", () => {
  const statuses: DeviceBlockStatus[] = [
    "scheduled",
    "in-progress",
    "done",
    "partial",
    "skipped",
    "missed",
    "rolled",
  ];
  const categories: Category[] = ["fitness", "work", "misc", "self-care", "self-development"];
  const blockArb = fc
    .record({
      status: fc.constantFrom(...statuses),
      category: fc.constantFrom(...categories),
      moved: fc.boolean(),
    })
    .map((r) =>
      block(r.status, {
        category: r.category,
        ...(r.moved
          ? { movedFrom: { start: "2025-03-10T14:00:00Z", end: "2025-03-10T15:00:00Z" } }
          : {}),
      }),
    );

  // Feature: timeblocker, Property 30: Dashboard percentages are within 0..100 and counts non-negative
  it("percentages are within 0..100 and counts are non-negative", () => {
    fc.assert(
      fc.property(
        fc.array(blockArb, { maxLength: 40 }),
        fc.array(fc.integer({ min: 0, max: 100 }), { maxLength: 7 }),
        fc.constantFrom("granted", "denied", "unknown" as const),
        (blocks, scores, usageStatus) => {
          const v = dash({
            blocks,
            sleepScores: scores.map((s, i) => night(`2025-03-${10 + i}`, s)),
            usageStatus,
          });
          expect(v.widgets).toHaveLength(4);
          for (const w of v.widgets) {
            expect(w.value).not.toBe("");
            expect(w.caption).not.toBe("");
            if (w.value === "—") continue;
            if (w.id === "sleep") {
              expect(w.value).toMatch(/^(10\.0|\d\.\d)$/);
              continue;
            }
            const n = Number(w.value.replace("%", ""));
            expect(Number.isInteger(n)).toBe(true);
            expect(n).toBeGreaterThanOrEqual(0);
            if (w.id !== "moved") expect(n).toBeLessThanOrEqual(100);
          }
          const moved = Number(widgetOf(v, "moved").value);
          expect(moved).toBeGreaterThanOrEqual(0);
          expect(moved).toBeLessThanOrEqual(blocks.length);
          expect(PROGRESS).toContain(v.progress);
        },
      ),
    );
  });
});

describe("buildDashboard important deadlines", () => {
  const base: DashboardInput = { now: NOW, weekId: WEEK, blocks: [], sleepScores: [], usageStatus: "granted" };
  const due = (ms: number) => new Date(ms).toISOString();

  it("is empty by default", () => {
    expect(buildDashboard(base).important).toEqual({ rows: [], moreCount: 0 });
  });

  it("falls back to blocks when no deadlineBlocks are given", () => {
    const b = block("scheduled", { dueAt: due(NOW + 3_600_000) });
    expect(buildDashboard({ ...base, blocks: [b] }).important.rows.map((r) => r.id)).toEqual([b.id]);
  });

  it("uses deadlineBlocks and deadlineItems instead of blocks", () => {
    const widgetBlock = block("scheduled", { dueAt: due(NOW + 3_600_000) });
    const later = block("scheduled", { dueAt: due(NOW + 9 * 86_400_000), weekId: "2025-03-16" });
    const view = buildDashboard({
      ...base,
      blocks: [widgetBlock],
      deadlineBlocks: [later],
      deadlineItems: [
        { id: "u", text: "Paper", durationMin: 60, priority: 1, category: "work", confirmed: true, weekId: WEEK, dueAt: due(NOW + 2 * 86_400_000) },
      ],
    });
    expect(view.important.rows.map((r) => r.id)).toEqual(["u", later.id]);
    expect(view.widgets[0]!.caption).toBe("0 of 1 done");
  });
});

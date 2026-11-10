import { describe, expect, it } from "vitest";
import type { DeviceBlock, PendingWrite } from "./models.js";
import {
  DEFAULT_DEVICE_SETTINGS,
  KEYS,
  Repositories,
  coalesceOutbox,
  encodeDocument,
  type CorruptDocument,
} from "./repositories.js";
import { MemoryKeyValueStore } from "./testkit.js";

const WEEK = "2025-06-01";

function block(id: string, overrides: Partial<DeviceBlock> = {}): DeviceBlock {
  return {
    id,
    itemId: `item-${id}`,
    weekId: WEEK,
    title: `Block ${id}`,
    category: "work",
    start: "2025-06-02T13:00:00.000Z",
    end: "2025-06-02T14:00:00.000Z",
    status: "scheduled",
    calendarEventId: `evt${id}00`,
    calendarSynced: false,
    promptedMeetingIds: [],
    usagePrompted: false,
    updatedAt: 1,
    ...overrides,
  } as DeviceBlock;
}

describe("Repositories: defaults", () => {
  it("returns defaults for an empty store", async () => {
    const repos = new Repositories(new MemoryKeyValueStore());
    expect(await repos.settings.get()).toEqual(DEFAULT_DEVICE_SETTINGS);
    expect(await repos.items.get(WEEK)).toEqual([]);
    expect(await repos.blocks.get(WEEK)).toEqual([]);
    expect(await repos.outbox.get()).toEqual([]);
    expect(await repos.intakeDraft.get()).toBeNull();
    expect(await repos.reviews.get(WEEK)).toBeNull();
    expect(await repos.calendarCache.get(WEEK)).toBeNull();
    expect(await repos.notifRegistry.get()).toEqual([]);
    expect(await repos.openPrompts.get()).toEqual([]);
    expect(await repos.undo.get()).toBeNull();
    expect(await repos.syncState.get()).toEqual({});
    expect(await repos.authState.get()).toEqual({ status: "signed-out" });
    expect(await repos.permissionState.get()).toEqual({
      notificationsRequested: false,
      exactAlarmsAvailable: false,
    });
  });

  it("settings default to exactly one planning mode", async () => {
    const settings = await new Repositories(new MemoryKeyValueStore()).settings.get();
    expect(["earliest-fit", "spread"]).toContain(settings.planningMode);
  });

  it.each([
    ["unparseable JSON", "{not json", "unparseable"],
    ["unknown schemaVersion", JSON.stringify({ schemaVersion: 2, data: [] }), "unknown-schema-version"],
    ["missing envelope", JSON.stringify([]), "unknown-schema-version"],
    ["wrong shape", encodeDocument({ not: "an array" }), "invalid-shape"],
  ])("returns defaults on %s and reports a diagnostic", async (_label, raw, reason) => {
    const diagnostics: CorruptDocument[] = [];
    const kv = new MemoryKeyValueStore({
      [KEYS.blocks(WEEK)]: raw,
      [KEYS.outbox]: raw,
      [KEYS.settings]: raw,
      [KEYS.authState]: raw,
    });
    const repos = new Repositories(kv, { onCorrupt: (d) => diagnostics.push(d) });
    expect(await repos.blocks.get(WEEK)).toEqual([]);
    expect(await repos.outbox.get()).toEqual([]);
    expect(await repos.settings.get()).toEqual(DEFAULT_DEVICE_SETTINGS);
    expect(await repos.authState.get()).toEqual({ status: "signed-out" });
    expect(diagnostics.map((d) => d.reason)).toEqual([reason, reason, reason, reason]);
  });

  it("rejects settings with an invalid planning mode", async () => {
    const kv = new MemoryKeyValueStore({
      [KEYS.settings]: encodeDocument({
        planningMode: "both",
        holidays: [],
        distractionApps: [],
      }),
    });
    expect(await new Repositories(kv).settings.get()).toEqual(DEFAULT_DEVICE_SETTINGS);
  });
});

describe("Repositories: round trip and atomic writes", () => {
  it("reads back saved documents through a fresh repository", async () => {
    const kv = new MemoryKeyValueStore();
    const repos = new Repositories(kv);
    await repos.settings.save({
      planningMode: "spread",
      holidays: ["2025-07-01"],
      distractionApps: ["com.example.app"],
    });
    await repos.blocks.save(WEEK, [block("a")]);
    await repos.authState.save({ status: "session-ended", reason: "transport" });

    const fresh = new Repositories(kv);
    expect(await fresh.settings.get()).toEqual({
      planningMode: "spread",
      holidays: ["2025-07-01"],
      distractionApps: ["com.example.app"],
    });
    expect(await fresh.blocks.get(WEEK)).toEqual([block("a")]);
    expect(await fresh.authState.get()).toEqual({ status: "session-ended", reason: "transport" });
    expect(kv.data.get(KEYS.schemaVersion)).toBe("1");
    expect(JSON.parse(kv.data.get(KEYS.settings)!).schemaVersion).toBe(1);
  });

  it("writes blocks and outbox in one setMany", async () => {
    const kv = new MemoryKeyValueStore();
    const repos = new Repositories(kv);
    const b = block("a");
    await repos.saveBlocksWithOutbox(WEEK, [b], [
      { blockId: b.id, calendarEventId: b.calendarEventId, op: "upsert", enqueuedAt: 5 },
    ]);
    expect(kv.writes).toBe(1);
    expect(await repos.blocks.get(WEEK)).toEqual([b]);
    expect(await repos.outbox.get()).toEqual([
      { blockId: "a", calendarEventId: b.calendarEventId, op: "upsert", attempts: 0, enqueuedAt: 5 },
    ]);
  });

  it("a failed atomic write changes nothing", async () => {
    const kv = new MemoryKeyValueStore();
    const repos = new Repositories(kv);
    kv.failNextWrite();
    await expect(
      repos.saveBlocksWithOutbox(WEEK, [block("a")], [
        { blockId: "a", calendarEventId: "evta00", op: "upsert", enqueuedAt: 1 },
      ]),
    ).rejects.toThrow();
    expect(kv.snapshot()).toEqual({});
  });
});

describe("outbox coalescing", () => {
  it("keeps one entry per block and the latest op wins", () => {
    let outbox: PendingWrite[] = [];
    outbox = coalesceOutbox(outbox, { blockId: "a", calendarEventId: "evta", op: "upsert", enqueuedAt: 1 });
    outbox = coalesceOutbox(outbox, { blockId: "b", calendarEventId: "evtb", op: "upsert", enqueuedAt: 2 });
    outbox = coalesceOutbox(outbox, { blockId: "a", calendarEventId: "evta", op: "upsert", enqueuedAt: 3 });
    expect(outbox.map((w) => w.blockId)).toEqual(["a", "b"]);

    outbox = coalesceOutbox(outbox, { blockId: "a", calendarEventId: "evta", op: "delete", enqueuedAt: 4 });
    expect(outbox).toEqual([
      { blockId: "a", calendarEventId: "evta", op: "delete", attempts: 0, enqueuedAt: 1 },
      { blockId: "b", calendarEventId: "evtb", op: "upsert", attempts: 0, enqueuedAt: 2 },
    ]);
  });

  it("resets attempts and lastError when a newer write replaces a failed one", () => {
    const failed: PendingWrite = {
      blockId: "a",
      calendarEventId: "evta",
      op: "upsert",
      attempts: 3,
      lastError: "Calendar unavailable",
      enqueuedAt: 1,
    };
    const [next] = coalesceOutbox([failed], {
      blockId: "a",
      calendarEventId: "evta",
      op: "upsert",
      enqueuedAt: 9,
    });
    expect(next).toEqual({ blockId: "a", calendarEventId: "evta", op: "upsert", attempts: 0, enqueuedAt: 1 });
  });

  it("enqueue and removeBlock persist through the repository", async () => {
    const repos = new Repositories(new MemoryKeyValueStore());
    await repos.outbox.enqueue(
      { blockId: "a", calendarEventId: "evta", op: "upsert", enqueuedAt: 1 },
      { blockId: "a", calendarEventId: "evta", op: "upsert", enqueuedAt: 2 },
      { blockId: "b", calendarEventId: "evtb", op: "delete", enqueuedAt: 3 },
    );
    expect((await repos.outbox.get()).map((w) => w.blockId)).toEqual(["a", "b"]);
    await repos.outbox.removeBlock("a");
    expect((await repos.outbox.get()).map((w) => w.blockId)).toEqual(["b"]);
  });
});

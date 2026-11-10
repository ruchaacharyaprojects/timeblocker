# @timeblocker/scheduling-engine

Pure, deterministic scheduling engine for TimeBlocker. **No network, no I/O, no
mutable global state** — every R3 constraint is unit-testable in isolation. All
scheduling is computed in **America/Toronto**, never the device timezone.

## Public API

```ts
weekBounds(date): Week
  // Sunday 00:00 .. following Sunday 00:00 (America/Toronto) for the week
  // containing `date`. DST-safe.

freeWindows(week, busyEvents, constraints, now?): FreeWindow[]
  // Schedulable windows (R3.7) minus fixed constraints (R3.1-R3.6, R3.10,
  // R3.11), real calendar events, and time before `now`. Gaps < 15 min
  // dropped (R3.8).

place(items, freeWindows, mode): { placed, unplaced }
  // Priority-first greedy placement. mode ∈ { "earliest-fit", "spread" }.
  // Enforces one-workout-per-day (R3.9) and Friday-night no-heavy-work
  // (R3.12). Never forces an item: unfit items come back as `unplaced`.

reschedule(block, week, busy, constraints): Slot | "no-fit"
  // Next valid slot in the same Sunday-Saturday week, or "no-fit".
```

## Fixed constraints (R3)

| Rule  | Behavior                                                          |
| ----- | ---------------------------------------------------------------- |
| R3.1  | Work Mon-Fri 08:30-16:30 (blocks only in meeting-free time)      |
| R3.2  | Canadian statutory holidays => day off, no work window (overridable) |
| R3.3  | Commute Tue/Thu/Fri 08:00-08:30 & 16:30-17:00; Mon/Wed remote    |
| R3.4  | Sleep 22:00-06:30 daily                                          |
| R3.5  | Wake-up 06:30-06:50; weekday blocks start >= 06:50               |
| R3.6  | Dinner 18:00-19:00 daily                                         |
| R3.7  | Windows: weekdays 06:50-22:00, weekends 10:00-21:00              |
| R3.8  | Gaps < 15 min are unusable                                       |
| R3.9  | At most one workout/day (short power walks exempt)               |
| R3.10 | Morning routine: ~20-min walk at 06:50                           |
| R3.11 | >= 30 min screen-free wind-down before bed                       |
| R3.12 | Friday night: no heavy work; lean to self-care/chill             |

## Commands

```bash
npm install      # once
npm test         # run the unit test suite (vitest)
npm run build    # compile to dist/
npm run typecheck
```

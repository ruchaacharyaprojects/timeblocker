# TimeBlocker Steering

These rules apply to all work on the TimeBlocker app.

- Timezone is America/Toronto. Never use the device timezone for scheduling.
- The week is always Sunday to Saturday. Never cross that boundary when rescheduling.
- Never schedule over sleep, dinner, or commute. Never force an item that doesn't fit.
- Keep the scheduling engine pure and free of I/O so it stays testable.
- Never upload raw phone usage. Aggregate on the device and send only summary signals.
- Single user only. Don't add multi-user abstractions.

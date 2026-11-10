# @timeblocker/infra

AWS CDK (TypeScript) infrastructure for the TimeBlocker serverless backend.

## What it provisions

- **API Gateway (REST, stage `v1`)** fronting four Lambdas with `POST` routes:
  - `/intake` → intake Lambda (R1: Bedrock OCR + category suggestions)
  - `/planning` → planning Lambda (R2: runs the scheduling engine)
  - `/reschedule` → reschedule Lambda (R6: next-slot search)
  - `/calendar-sync` → calendar-sync Lambda (R4: Google Calendar read/write)
- **DynamoDB tables** (`timeblocker-items`, `timeblocker-blocks`,
  `timeblocker-settings`, `timeblocker-reviews`) with AWS-managed encryption at
  rest and point-in-time recovery.
- **EventBridge Scheduler** (all in `America/Toronto`):
  - `rate(15 minutes)` — custom block/meeting reminders (R5)
  - `cron(0 8 ? * SUN *)` — Sunday planning nudge (R9)
  - `cron(0 18 ? * SAT *)` — Saturday review (R9)
- **Secrets Manager** secret `timeblocker/google-oauth-tokens` for Google OAuth
  tokens (R4).

## Secure defaults

- Tables encrypted at rest (AWS-managed KMS) with point-in-time recovery and a
  `RETAIN` removal policy so data is not destroyed on stack delete.
- Least-privilege IAM: each Lambda is granted only the specific table
  actions it needs (read vs. read/write) and only the functions that talk to
  Google can read the OAuth secret. Intake is scoped to `bedrock:InvokeModel`.
- EventBridge Scheduler assumes a dedicated role scoped to invoking only the
  scheduler Lambda.
- API Gateway access logging enabled to a dedicated CloudWatch log group.

## Commands

```bash
npm install          # install dependencies
npm run typecheck    # type-check without emitting
npm test             # run the CDK assertion unit tests (vitest)
npm run synth        # cdk synth (no deploy)
```

The **planning** Lambda (`lambda/planning/`) is wired (task 4): it reads the
week's Google Calendar events, subtracts the fixed R3 constraints and those
events to build free windows, runs the scheduling engine in the configured
planning mode, writes the placed solo blocks to the calendar, persists them to
the blocks table, and returns placed + unplaced items — including the
shrink / drop / roll-to-next-week alert for anything that fits nowhere (R2.3).
Its orchestration lives in `lambda/planning/plan.ts` behind injected ports and
is unit-tested in `test/planning.test.ts` without a network; the handler in
`lambda/planning/index.ts` only wires the concrete adapters (Secrets Manager,
Google OAuth + Calendar over `fetch`, DynamoDB). It expects `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` in the environment in
addition to the table and secret vars the stack already injects.

The **intake** Lambda (`lambda/intake/`) is wired (task 5). `POST /intake`
takes two actions, selected by the request body:

- `{ action: "extract", weekId, photoBase64 }` — runs Bedrock OCR + category
  suggestions on the photo, parses candidate items (suggested duration,
  priority, category), and persists them to the items table **unconfirmed**
  (R1.1). On OCR failure or empty/low-confidence output the raw guesses are
  surfaced for manual correction and nothing is auto-scheduled.
- `{ action: "confirm", weekId, edits }` — applies the reviewer's edits to
  duration / priority / category, marks exactly those items `confirmed: true`
  (R1.2), persists them, and only then triggers the planning Lambda (R1.3).
  An empty confirmation schedules nothing.

Its orchestration lives in `lambda/intake/intake.ts` behind injected ports
(`OcrPort`, `ItemsStore`, `PlanningTrigger`, `IdGenerator`) and is unit-tested
in `test/intake.test.ts` without a network; the handler in
`lambda/intake/index.ts` only wires the concrete adapters (Bedrock Runtime,
DynamoDB, and an async Lambda invoke of the planning function). The stack
passes `PLANNING_FUNCTION_NAME` to intake and grants it invoke on planning;
`OCR_MODEL_ID` is optional (defaults to a Claude 3.5 Sonnet vision model).

The remaining Lambda handlers under `lambda/` are deployable placeholders; the
calendar and review behavior is wired by the later spec tasks (2, 10). This
package only defines and synthesizes the infrastructure. Nothing here deploys
automatically.

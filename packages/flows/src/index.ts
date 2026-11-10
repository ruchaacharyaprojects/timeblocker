/**
 * @timeblocker/flows: pure orchestration shared by the infra Lambdas and the
 * on-device app core. No network or I/O.
 *
 * Each module is also available as a namespace (`intake`, `plan`,
 * `reschedule`, `prompt`, `detect`, `review`) for names that would otherwise
 * collide at the top level (for example each module's `SettingsReader` port).
 */
export {
  BLOCK_STATUSES,
  isBlockStatus,
  type BlockStatus,
  type PersistedBlock,
} from "./block.js";

export * as intake from "./intake.js";
export * as plan from "./plan.js";
export * as reschedule from "./reschedule.js";
export * as prompt from "./prompt.js";
export * as detect from "./detect.js";
export * as review from "./review.js";

// --- Intake (R1) -----------------------------------------------------------
export * from "./intake.js";

// --- Intake estimation (R15) -------------------------------------------------
export * from "./estimate.js";

// --- Schedule text (R28) ----------------------------------------------------
export * from "./schedule.js";
// --- Learned placement (R23) -------------------------------------------------
export * from "./preferences.js";
// --- Planning (R2) ---------------------------------------------------------
export {
  computePlan,
  runPlanning,
  buildNothingFitsAlert,
  weekIdOf,
  DEFAULT_SETTINGS as DEFAULT_PLANNING_SETTINGS,
  type ComputePlanInput,
  type ComputePlanResult,
  type NothingFitsAlert,
  type NothingFitsOption,
  type PlanningSettings,
  type PlanningResult,
  type PlanningRequest,
  type PlanningDeps,
  type ItemsReader,
  type SettingsReader as PlanningSettingsReader,
  type CalendarPort as PlanningCalendarPort,
  type BlocksWriter as PlanningBlocksWriter,
} from "./plan.js";

// --- Reschedule (R6) -------------------------------------------------------
export {
  computeReschedule,
  runReschedule,
  applyUndo,
  DEFAULT_SETTINGS as DEFAULT_RESCHEDULE_SETTINGS,
  type ComputeRescheduleInput,
  type ComputeRescheduleResult,
  type RescheduleRequest,
  type RescheduleSettings,
  type RescheduleOutcome,
  type RescheduleDeps,
  type UndoToken,
  type PromptAnswer,
  type BlocksReader as RescheduleBlocksReader,
  type BlocksWriter as RescheduleBlocksWriter,
  type SettingsReader as RescheduleSettingsReader,
  type CalendarPort as RescheduleCalendarPort,
} from "./reschedule.js";

// --- Miss prompt (R6.1) ----------------------------------------------------
export * from "./prompt.js";

// --- Conflict detection (R6.1, R14.4) --------------------------------------
export {
  overlaps,
  findConflicts,
  runMeetingConflictDetection,
  runMeetingConflictAnswer,
  type Span,
  type BlockConflict,
  type WeekBlocksReader,
  type CalendarReadPort,
  type PromptRaiser,
  type DetectionDeps,
  type DetectionRequest,
  type DetectionResult,
  type RaisedPrompt,
} from "./detect.js";

// --- Weekly review (R8.1, R9) ----------------------------------------------
export {
  buildWeeklyReview,
  runSaturdayReview,
  runSundayPlanningNudge,
  buildSundayNudge,
  NEXT_WEEK_PHOTO_PROMPT,
  NEXT_WEEK_LIST_PROMPT,
  ROLLED_DEFAULT_REASON,
  MOVED_DEFAULT_REASON,
  SUNDAY_NUDGE_TITLE,
  SUNDAY_NUDGE_BODY,
  type ReviewEntry,
  type MovedEntry,
  type WeeklyReview,
  type ReviewBlocksReader,
  type ReviewBlocksWriter,
  type ReviewWriter,
  type UsageSummaryReader,
  type NudgeNotification,
  type NudgePort,
  type SaturdayReviewDeps,
  type SaturdayReviewRequest,
  type SundayNudgeDeps,
  type SundayNudgeRequest,
} from "./review.js";

/**
 * @timeblocker/app-core: the pure on-device TimeBlocker app core.
 *
 * Services, ports, repositories, and view models live here and run under
 * Node; `@timeblocker/mobile` supplies thin adapters for the ports. This
 * package must never import `react-native`, native libraries, AWS SDKs, CDK,
 * or `@timeblocker/infra` (R12.6, R12.8); a structural test enforces it.
 */
export * from "./ports.js";
export * from "./models.js";
export { CalendarHttpError } from "@timeblocker/calendar-integration";
export * from "./http.js";
export * from "./calendarApi.js";
export * from "./repositories.js";
export * from "./services/settings.js";
export * from "./tokenProvider.js";
export * from "./notifications/desired.js";
export * from "./notifications/forecast.js";
export * from "./services/intake.js";
export * from "./services/history.js";
export * from "./services/forecasts.js";
export * from "./services/auth.js";
export * from "./services/idToken.js";
export * from "./services/googleIdToken.js";
export * from "./services/aiProfile.js";
export * from "./ai/contract.js";
export * from "./notifications/reconcile.js";
export * from "./notifications/service.js";
export * from "./sync/syncService.js";
export * from "./services/planning.js";
export * from "./services/holidays.js";
export * from "./services/weekReset.js";
export * from "./services/review.js";
export * from "./services/usageRisk.js";
export * from "./viewModels/index.js";
export * from "./services/lifecycle.js";
export * from "./services/blockActions.js";
export * from "./services/sleep.js";
export * from "./demo/demoData.js";
export * from "./demo/demoService.js";

/**
 * TimeBlocker Google Calendar integration.
 *
 * OAuth with Calendar scopes, token storage (DynamoDB settings table, with a
 * Secrets Manager store still available as an option), reading the week's
 * events, and writing solo blocks with the 🧱 prefix, per-category colors,
 * and suppressed reminders (R4.1, R4.2). Request building and parsing
 * are pure; networked exchange/refresh and the Calendar REST calls go through
 * injected ports so the module is unit-testable without a network.
 */

export * from "./types.js";
export {
  BLOCK_PREFIX,
  CATEGORY_COLOR_ID,
  SUPPRESSED_REMINDERS,
  withBlockPrefix,
  colorIdForCategory,
  buildEventRequest,
  parseCalendarEvent,
  hasOtherAttendees,
  isBlockSummary,
  toBusyEvents,
  type RawGoogleEvent,
} from "./events.js";
export {
  EXPIRY_SKEW_MS,
  GoogleOAuthClient,
  buildAuthUrl,
  parseTokenResponse,
  isExpired,
  type HttpClient,
  type TokenStore,
} from "./oauth.js";
export {
  SecretsManagerTokenStore,
  DynamoDBTokenStore,
  serializeTokens,
  deserializeTokens,
  type SecretsManagerPort,
  type TokenTablePort,
} from "./secrets.js";
export {
  GoogleCalendarClient,
  CalendarHttpError,
  buildListUrl,
  buildHolidayUrl,
  expandDates,
  type HolidayEntry,
  type CalendarHttpClient,
  type AccessTokenProvider,
} from "./calendar.js";

/**
 * API contract of the TimeBlocker AI backend (design D28).
 * Dependency-free so the app (app-core / mobile) can mirror these types verbatim.
 */

export const CATEGORIES = ["work", "self-development", "fitness", "self-care", "misc"] as const;
export type AiCategory = (typeof CATEGORIES)[number];

export const KINDS = ["task", "application", "email", "study", "workout", "errand", "other"] as const;
export type AiKind = (typeof KINDS)[number];

export const MODES = ["application", "email", "study"] as const;
export type AiMode = (typeof MODES)[number];

/** Hard limits shared by server validation and the app. */
export const LIMITS = {
  bodyBytes: 16 * 1024,
  titlesMax: 40,
  titleChars: 200,
  titleFieldChars: 200,
  jobChars: 6000,
  questionChars: 600,
  backgroundChars: 3000,
  intentChars: 300,
  pointsMax: 6,
  draftWords: 120,
  emailWords: 120,
  studyStepsMax: 6,
  checklistMax: 6,
} as const;

// POST /ai/parse-tasks
export interface ParseTasksRequest {
  titles: string[];
}
export interface ParseTasksItem {
  index: number;
  category: AiCategory;
  kind: AiKind;
}
export interface ParseTasksResponse {
  items: ParseTasksItem[];
}

// POST /ai/application-help
export interface ApplicationHelpRequest {
  mode: AiMode;
  title?: string;
  job?: string;
  question?: string;
  background?: string;
  intent?: string;
}
export interface TalkingPoint {
  text: string;
  quote: string;
}
export interface ApplicationHelpApplicationResponse {
  points: TalkingPoint[];
  missing: string[];
  draft: string;
  checklist?: string[];
}
export interface ApplicationHelpEmailResponse {
  subject: string;
  body: string;
}
export interface ApplicationHelpStudyResponse {
  steps: string[];
}
export type ApplicationHelpResponse =
  | ApplicationHelpApplicationResponse
  | ApplicationHelpEmailResponse
  | ApplicationHelpStudyResponse;

export type AiErrorCode =
  | "invalid_request"
  | "forbidden"
  | "throttled"
  | "model_error"
  | "timeout"
  | "not_found"
  | "method_not_allowed"
  | "internal";

export interface AiErrorBody {
  error: AiErrorCode;
}

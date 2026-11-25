const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Time-to-live per kind. null = never expires (decisions; see design.md live dissent). */
export const TTL_MS = {
  heartbeat: 4 * HOUR,
  push: DAY,
  pr: 7 * DAY,
  status: 2 * DAY,
  progress: 2 * DAY,
  blocker: 2 * DAY,
  ask: 2 * DAY,
  decision: null,
} as const satisfies Record<string, number | null>;
export type Kind = keyof typeof TTL_MS;
export const INTENT_KINDS = ["status", "progress", "blocker", "decision", "ask"] as const;

export const SUMMARY_MAX = 200;
export const DETAILS_MAX = 1000;
export const PATHS_MAX = 50;
export const PATH_LEN_MAX = 200;
export const BRANCH_MAX = 100;
export const BODY_MAX_BYTES = 64 * 1024;
export const WEBHOOK_BODY_MAX_BYTES = 2 * 1024 * 1024; // GitHub push payloads with 20 commits can exceed 64 KB
export const MAP_MAX_PATHS = 500;
export const DIGEST_REPO_ROWS = 10;
export const DIGEST_OTHER_ROWS = 4;
export const DIGEST_PATHS_PER_ROW = 6;
export const OTHER_REPO_WINDOW_MS = DAY;
export const EVENT_RETENTION_MS = 30 * DAY;
export const DELIVERY_RETENTION_MS = 7 * DAY;

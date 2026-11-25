export interface Env {
  LEDGER_DB: D1Database;
  EXPORTS: R2Bucket;
  OAUTH_KV: KVNamespace;
  ALLOWED_REPOS: string;
  PUBLIC_URL: string; // e.g. https://session-link.example.workers.dev
  WEBHOOK_SECRET: string;
  ADMIN_TOKEN: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_KEY: string; // 32+ chars; signs web sessions and remembered consent
  OPERATORS?: string; // optional secret: logins that can manage access without showing as admins
}

import fs from "node:fs";
import path from "node:path";
import { createClient, type Client, type InArgs, type Transaction } from "@libsql/client";
import { applySchema } from "./schema.mjs";
import { remoteConfig } from "./env.mjs";

/**
 * libSQL-backed persistent store.
 *
 * One driver covers both deployments:
 *   - local dev  — TURSO_DATABASE_URL unset, so it falls back to a `file:`
 *                  URL and behaves exactly like the old embedded SQLite.
 *   - hosted     — TURSO_DATABASE_URL=libsql://… with TURSO_AUTH_TOKEN, which
 *                  is what makes the app work on a serverless host like
 *                  Vercel, where the filesystem is not writable or persistent.
 *
 * Because a remote database is reached over the network, every call here is
 * async. That is the reason the repository layer is async throughout.
 */

const DEFAULT_DB_FILE = path.join(process.cwd(), "data", "clipur.db");

/** Resolves the connection URL, preferring a hosted database. */
function resolveUrl(): string {
  const remote = remoteConfig();
  if (remote) return remote.url;

  const filePath = process.env.CLIPUR_DB_PATH?.trim() || DEFAULT_DB_FILE;
  const absolute = path.resolve(filePath);
  // The driver creates the file but not the directory above it. On a
  // serverless host the filesystem is read-only, so this throws — which is
  // the correct, loud failure: the deployment is missing its database URL.
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  return `file:${absolute}`;
}

type GlobalDb = {
  __clipurClient?: Client;
  __clipurSchema?: Promise<void>;
};

// Cached on globalThis: Next.js reloads modules in dev and must not open a
// new connection per reload.
const globalForDb = globalThis as unknown as GlobalDb;

export function getClient(): Client {
  if (!globalForDb.__clipurClient) {
    globalForDb.__clipurClient = createClient({
      url: resolveUrl(),
      authToken: remoteConfig()?.authToken,
    });
  }
  return globalForDb.__clipurClient;
}

/** Creates the schema once per process, not once per query. */
export function ensureSchema(): Promise<void> {
  if (!globalForDb.__clipurSchema) {
    globalForDb.__clipurSchema = applySchema(getClient());
  }
  return globalForDb.__clipurSchema;
}

/**
 * Anything that can run a statement: the client itself, or an open
 * transaction. Repository helpers take one of these so a function can be
 * reused inside or outside a transaction.
 */
export interface Executor {
  execute(stmt: { sql: string; args?: InArgs } | string): Promise<unknown>;
}

/** Runs a query and returns rows as plain objects. */
export async function query<T>(sql: string, args: InArgs = []): Promise<T[]> {
  await ensureSchema();
  const result = await getClient().execute({ sql, args });
  // Spreading each row drops libSQL's prototype, so rows are safe to hand to
  // a React Client Component.
  return result.rows.map((row) => ({ ...row }) as T);
}

/** Runs a query expected to match at most one row. */
export async function queryOne<T>(sql: string, args: InArgs = []): Promise<T | undefined> {
  const rows = await query<T>(sql, args);
  return rows[0];
}

/** Runs a statement for its effect. */
export async function execute(sql: string, args: InArgs = []): Promise<void> {
  await ensureSchema();
  await getClient().execute({ sql, args });
}

/** Runs a statement on a specific executor — used inside transactions. */
export async function run(executor: Executor, sql: string, args: InArgs = []): Promise<void> {
  await executor.execute({ sql, args });
}

/** Reads rows from a specific executor, as plain objects. */
export async function select<T>(
  executor: Executor,
  sql: string,
  args: InArgs = [],
): Promise<T[]> {
  const result = (await executor.execute({ sql, args })) as { rows: unknown[] };
  return result.rows.map((row) => ({ ...(row as object) }) as T);
}

/**
 * Runs `fn` inside a write transaction, committing on success and rolling
 * back on throw.
 *
 * The transaction is passed in rather than tracked globally, so a helper that
 * needs to join it takes it as an argument. That removes the nested-
 * transaction problem entirely.
 */
export async function withTx<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  await ensureSchema();
  const tx = await getClient().transaction("write");
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (error) {
    try {
      await tx.rollback();
    } catch {
      // A rollback failure must not mask the original error.
    }
    throw error;
  }
}

/** True once the seed script has created the admin accounts. */
export async function isSeeded(): Promise<boolean> {
  const row = await queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM users");
  return Number(row?.n ?? 0) > 0;
}

/** True when pointed at a remote database rather than a local file. */
export function isRemote(): boolean {
  return remoteConfig() !== null;
}

export { remoteConfig };

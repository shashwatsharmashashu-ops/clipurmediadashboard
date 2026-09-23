/**
 * Where the database lives, resolved from the environment.
 *
 * Shared by lib/db.ts (the running app) and scripts/seed.mjs, so both agree on
 * which database they are talking to — seeding the wrong one is a confusing
 * failure to debug.
 *
 * Vercel's Turso integration derives its variable names from a prefix chosen
 * during setup, so the exact name is not known in advance. Checking the
 * plausible spellings is more robust than forcing one and having the
 * deployment fail on boot. `TURSO_DATABASE_URL` remains the documented,
 * canonical name.
 */

export const URL_VARS = [
  "TURSO_DATABASE_URL",
  "TURSO_URL",
  "TURSO_CONNECTION_URL",
  "LIBSQL_URL",
  "DATABASE_URL",
  "STORAGE_URL",
];

export const TOKEN_VARS = [
  "TURSO_AUTH_TOKEN",
  "TURSO_DATABASE_AUTH_TOKEN",
  "TURSO_TOKEN",
  "LIBSQL_AUTH_TOKEN",
  "DATABASE_AUTH_TOKEN",
  "STORAGE_AUTH_TOKEN",
];

/** A remote URL the libSQL driver can actually dial. */
export function isRemoteUrl(value) {
  return /^(libsql|wss|ws|https|http):\/\//i.test(value);
}

function firstEnv(env, names, accept) {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value && (!accept || accept(value))) return { name, value };
  }
  return null;
}

/**
 * The configured remote database, or null when running against a local file.
 * Returns the variable names too, so tooling can report what it picked up.
 */
export function remoteConfig(env = process.env) {
  const url = firstEnv(env, URL_VARS, isRemoteUrl);
  if (!url) return null;

  const token = firstEnv(env, TOKEN_VARS);
  return {
    urlVar: url.name,
    url: url.value,
    tokenVar: token?.name ?? null,
    authToken: token?.value ?? undefined,
  };
}

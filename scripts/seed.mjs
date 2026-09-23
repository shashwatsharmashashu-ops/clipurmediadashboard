/**
 * First-run seeding for Clipur Media Command.
 *
 *   npm run seed                        seed content + admins (skips what exists)
 *   npm run seed -- --reset             wipe content and reseed it
 *   npm run seed -- --reset-passwords   issue fresh passwords for all admins
 *
 * Passwords are generated here, printed ONCE to stdout, and stored only as
 * scrypt hashes. Nothing plaintext is ever written to disk or to the repo.
 *
 * Content is seeded as real daily history: every clip carries the day it
 * counts toward, and each of those days gets its own frozen target, so the
 * calendar has something meaningful to show from the first render.
 */
import { createClient } from "@libsql/client";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applySchema, DEFAULT_DAILY_TARGET } from "../lib/schema.mjs";
import { generatePassword, hashPassword } from "../lib/crypto.mjs";
import { remoteConfig } from "../lib/env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Loads .env.local the way Next.js does, so seeding a hosted database is just
 * `npm run seed` — no shell-specific environment-variable syntax, which
 * differs between PowerShell, cmd and bash. Real environment variables still
 * win, so CI can override.
 */
function loadEnvLocal() {
  const file = path.join(root, ".env.local");
  if (!fs.existsSync(file)) return;

  for (const rawLine of fs.readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    // Strip matching surrounding quotes, which people often paste in.
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");

    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvLocal();

const dbPath = process.env.CLIPUR_DB_PATH ?? path.join(root, "data", "clipur.db");

const args = new Set(process.argv.slice(2));
const RESET_CONTENT = args.has("--reset");
const RESET_PASSWORDS = args.has("--reset-passwords");

// Local file by default; a hosted database when one is configured, which is
// how the same script seeds a deployment.
const remote = remoteConfig();
const url = remote?.url ?? `file:${dbPath}`;
if (!remote) fs.mkdirSync(path.dirname(dbPath), { recursive: true });

if (remote) {
  console.log(`Seeding the hosted database from ${remote.urlVar}`);
  if (!remote.tokenVar) {
    console.warn("  warning: no auth token variable found; the connection may be rejected.");
  }
} else {
  console.log("Seeding the local database file. Set TURSO_DATABASE_URL to seed a deployment.");
}

const db = createClient({ url, authToken: remote?.authToken });
await applySchema(db);

/**
 * Writes are queued rather than executed one at a time: against a remote
 * database, 1500 individual round trips would take minutes. The queue is
 * flushed in batches, each batch a single transaction.
 */
const queue = [];

/** Mimics a prepared statement, but appends to the queue instead of running. */
function stmt(sql) {
  return { run: (...args) => queue.push({ sql, args }) };
}

const BATCH_SIZE = 500;

async function flush() {
  while (queue.length > 0) {
    const chunk = queue.splice(0, BATCH_SIZE);
    await db.batch(chunk, "write");
  }
}

/** Reads a single COUNT(*)-style value. */
async function count(sql) {
  const result = await db.execute(sql);
  return Number(result.rows[0]?.n ?? 0);
}

const uid = (p) => `${p}_${crypto.randomBytes(8).toString("hex")}`;
const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------ admins */

const ADMINS = ["simon", "preston", "alec", "shashwat", "max", "himansh", "meet"];

async function seedAdmins() {
  const result = await db.execute("SELECT username FROM users");
  const existing = new Set(result.rows.map((row) => row.username));
  const issued = [];

  const insert = stmt(
    "INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
  );
  const updatePw = stmt("UPDATE users SET password_hash = ? WHERE username = ?");

  for (const username of ADMINS) {
    if (!existing.has(username)) {
      const password = generatePassword();
      insert.run(uid("user"), username, hashPassword(password), nowIso());
      issued.push({ username, password });
    } else if (RESET_PASSWORDS) {
      const password = generatePassword();
      updatePw.run(hashPassword(password), username);
      // Existing sessions must not survive a credential change.
      stmt(
        "DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)",
      ).run(username);
      issued.push({ username, password });
    }
  }
  return issued;
}

/* -------------------------------------------------------------------- days */

const HISTORY_DAYS = 7; // today plus the six days before it

function toIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Oldest first, ending on today. */
function historyDates() {
  const dates = [];
  for (let back = HISTORY_DAYS - 1; back >= 0; back--) {
    const date = new Date();
    date.setDate(date.getDate() - back);
    dates.push(toIsoDate(date));
  }
  return dates;
}

const DATES = historyDates();

/* ----------------------------------------------------------------- content */

/**
 * Clips per day for each scope, oldest first. Some days hit the 40/day target
 * exactly, some fall short, and the last entry is today mid-flight.
 */
const DAILY_PLANS = {
  ai: [40, 40, 28, 40, 35, 40, 17],
  crypto: [40, 40, 40, 40, 22, 38, 12],
  streamers: [36, 40, 40, 40, 40, 29, 21],
  clavicular: [40, 40, 40, 40, 40, 40, 9],
  instagram: [40, 40, 37, 40, 40, 34, 15],
  tiktok: [33, 40, 40, 40, 19, 40, 11],
};

/** The 14 X accounts, split across the four niches exactly as specified. */
const X_NICHES = [
  { key: "ai", name: "AI", accounts: ["MemeBank", "Clipur Culture", "VyralClips"] },
  {
    key: "crypto",
    name: "Crypto",
    accounts: ["CamiClipz", "VyralMoments", "Vyral News", "1UPClip"],
  },
  {
    key: "streamers",
    name: "Streamers",
    accounts: ["InternetKid69", "VyralXYZ", "Follow4Clips", "LeMemes"],
  },
  {
    key: "clavicular",
    name: "Clavicular",
    accounts: ["Monkey Clips", "Clipmaxxers", "ClipurNewsDaily"],
  },
];

/** Accounts that have finished their run — target equals what they made. */
const COMPLETED_ACCOUNTS = new Set(["Vyral News", "Follow4Clips"]);

const PLATFORM_ITEMS = [
  { platform: "instagram", group: "Hollywood", name: "Red carpet reaction cuts", status: "ongoing" },
  { platform: "instagram", group: "Hollywood", name: "Awards season edits", status: "ongoing" },
  { platform: "instagram", group: "Streamer", name: "Stream fail compilations", status: "ongoing" },
  { platform: "instagram", group: "Streamer", name: "Collab announcement teasers", status: "upcoming" },
  { platform: "tiktok", group: "Hollywood", name: "Celebrity interview cuts", status: "ongoing" },
  { platform: "tiktok", group: "Hollywood", name: "Press tour bloopers", status: "ongoing" },
  { platform: "tiktok", group: "Streamer", name: "Streamer reaction duets", status: "ongoing" },
  { platform: "tiktok", group: "Streamer", name: "Sub-a-thon highlights", status: "ongoing" },
];

const CAMPAIGNS = [
  { name: "Gosh.com", target: 50, made: 34, status: "ongoing" },
  { name: "HandlPay", target: 36, made: 9, status: "ongoing" },
  { name: "Duel", target: 28, made: 3, status: "upcoming" },
  { name: "Northbeam Labs", target: 18, made: 18, status: "completed" },
];

const STRATEGIES = [
  {
    title: "Serialised clip arcs",
    description:
      "Cut each fight week into a numbered 4-part arc instead of standalone posts. Part 1 seeds the conflict, part 4 pays it off, so posting cadence compounds rather than resetting daily.",
    status: "ongoing",
    platform: "x",
    selected: 1,
  },
  {
    title: "Reply-guy distribution",
    description:
      "Post the clip natively, then place cut-downs as replies under the three largest accounts already discussing the moment within the first 20 minutes. Doubles surface area per clip made, with no extra edit time.",
    status: "ongoing",
    platform: "x",
    selected: 0,
  },
  {
    title: "Hollywood-first vertical pipeline",
    description:
      "Instagram and TikTok run the same Hollywood and Streamer cut list. Editors master once in 9:16 and ship to both, which is what lets two platforms share one strategy without doubling edit hours.",
    status: "ongoing",
    platform: "instagram",
    selected: 1,
  },
  {
    title: "Niche-owned account rotation",
    description:
      "Rotate which of the 14 X accounts leads a given news cycle so no single handle burns its audience. Under discussion: whether Clavicular should lead breaking news instead of Crypto.",
    status: "in_discussion",
    platform: "x",
    selected: 0,
  },
  {
    title: "Monday batch, daily drip",
    description:
      "Batch the full week of edits on Monday, then release on a fixed daily schedule. Protects the daily target from mid-week client fire drills.",
    status: "concluded",
    platform: null,
    selected: 1,
    report: {
      reach: "1.4M across 6 weeks (reference only)",
      topClip: "Streamers — InternetKid69, sub-a-thon hour 61",
      verdict:
        "Keep it. Daily output stopped collapsing on weeks with client escalations, and the four X niches now clear 40/day far more often. Recommend making Monday batching the default across all niches and rolling it into IG/TikTok next quarter.",
    },
  },
];

const REPORTS = [
  {
    week: "Week 36 · Sep 1 – Sep 7, 2026",
    summary:
      "AI and Clavicular each hit the 40/day target on four of seven days. Crypto slipped mid-week when the news cycle went quiet. Instagram held pace on Hollywood; TikTok's press-tour run closed out at target.",
    postedDate: "2026-09-08",
  },
  {
    week: "Week 35 · Aug 25 – Aug 31, 2026",
    summary:
      "Streamers under-delivered while two editors were onboarding; Follow4Clips and Vyral News both finished their runs at target. Duel campaign kickoff pushed a week at the client request.",
    postedDate: "2026-09-01",
  },
  {
    week: "Week 34 · Aug 18 – Aug 24, 2026",
    summary:
      "First full week on the Monday batching schedule. Gosh.com ran four ahead of pace. Northbeam Labs wrapped at 18/18 and moved to completed.",
    postedDate: "2026-08-25",
  },
];

/* --------------------------------------------------------------- utilities */

let urlCounter = 1_800_000_000;
const nextUrlId = () => String(++urlCounter);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

const insertClip = stmt(
  `INSERT INTO clips (id, owner_type, owner_id, url, normalized_url, label, views, views_source, clip_date, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const CLIP_LABELS = [
  "Thread hook cut",
  "Reaction repost",
  "Breaking-news edit",
  "Explainer, 30s",
  "Quote-tweet dunk",
  "Timeline recap",
];

let clipIndex = 0;

function addClip(ownerType, ownerId, url, date) {
  const normalized = url
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();

  // Roughly a third of clips carry a manually entered view count; the rest
  // have none, which is completely normal and must render fine.
  const i = clipIndex++;
  const hasViews = i % 3 === 0;

  insertClip.run(
    uid("clip"),
    ownerType,
    ownerId,
    url,
    normalized,
    i % 2 === 0 ? CLIP_LABELS[i % CLIP_LABELS.length] : null,
    hasViews ? 4_000 + ((i * 7919) % 480_000) : null,
    hasViews ? "manual" : null,
    date,
    `${date}T12:00:00.000Z`,
  );
}

/**
 * Splits a day's count across the owners of a scope, rotating who absorbs the
 * remainder so one account does not always look busiest.
 */
function splitAcross(count, owners, dayIndex) {
  const share = Math.floor(count / owners.length);
  const remainder = count % owners.length;
  return owners.map((owner, i) => ({
    owner,
    count: share + ((i + dayIndex) % owners.length < remainder ? 1 : 0),
  }));
}

/* ------------------------------------------------------------------- seed */

function clearContent() {
  for (const table of [
    "clips",
    "accounts",
    "niches",
    "items",
    "strategies",
    "reports",
    "daily_targets",
    "day_targets",
  ]) {
    stmt(`DELETE FROM ${table}`).run();
  }
}

function seedContent() {
  const nicheInsert = stmt(
    "INSERT INTO niches (id, platform, key, name, sort) VALUES (?, ?, ?, ?, ?)",
  );
  const accountInsert = stmt(
    `INSERT INTO accounts (id, niche_id, handle, status, posts_target, posts_made, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const itemInsert = stmt(
    `INSERT INTO items (id, kind, platform, group_name, name, status, posts_target, posts_made, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const dailyTargetInsert = stmt(
    "INSERT INTO daily_targets (scope_type, scope_id, target) VALUES (?, ?, ?)",
  );
  const dayTargetInsert = stmt(
    "INSERT INTO day_targets (scope_type, scope_id, date, target) VALUES (?, ?, ?, ?)",
  );

  /* --- X: niches, accounts, and a clip per post per day ------------------ */

  for (const [nicheIndex, niche] of X_NICHES.entries()) {
    const nicheId = uid("niche");
    nicheInsert.run(nicheId, "x", niche.key, niche.name, nicheIndex);

    // The daily target lives on the niche, not the account.
    dailyTargetInsert.run("niche", nicheId, DEFAULT_DAILY_TARGET);
    for (const date of DATES) {
      dayTargetInsert.run("niche", nicheId, date, DEFAULT_DAILY_TARGET);
    }

    const accounts = niche.accounts.map((handle, i) => {
      const accountId = uid("acct");
      return { id: accountId, handle, sort: i, made: 0 };
    });

    DATES.forEach((date, dayIndex) => {
      const dayCount = DAILY_PLANS[niche.key][dayIndex];
      for (const { owner, count } of splitAcross(dayCount, accounts, dayIndex)) {
        for (let n = 0; n < count; n++) {
          addClip("account", owner.id, `https://x.com/${slug(owner.handle)}/status/${nextUrlId()}`, date);
          owner.made += 1;
        }
      }
    });

    for (const account of accounts) {
      const target = COMPLETED_ACCOUNTS.has(account.handle)
        ? account.made
        : Math.ceil((account.made * 1.25) / 10) * 10;
      accountInsert.run(
        account.id,
        nicheId,
        account.handle,
        account.made >= target ? "completed" : "ongoing",
        target,
        account.made,
        account.sort,
      );
    }
  }

  /* --- Instagram and TikTok: platform-level targets ---------------------- */

  for (const platform of ["instagram", "tiktok"]) {
    dailyTargetInsert.run("platform", platform, DEFAULT_DAILY_TARGET);
    for (const date of DATES) {
      dayTargetInsert.run("platform", platform, date, DEFAULT_DAILY_TARGET);
    }

    const definitions = PLATFORM_ITEMS.filter((item) => item.platform === platform);
    const items = definitions.map((definition, i) => ({
      ...definition,
      id: uid("item"),
      sort: i,
      made: 0,
    }));

    // An upcoming item has not started, so it takes none of the day's work.
    const active = items.filter((item) => item.status !== "upcoming");

    DATES.forEach((date, dayIndex) => {
      const dayCount = DAILY_PLANS[platform][dayIndex];
      for (const { owner, count } of splitAcross(dayCount, active, dayIndex)) {
        for (let n = 0; n < count; n++) {
          const url =
            platform === "instagram"
              ? `https://www.instagram.com/reel/${nextUrlId()}`
              : `https://www.tiktok.com/@clipur/video/${nextUrlId()}`;
          addClip("item", owner.id, url, date);
          owner.made += 1;
        }
      }
    });

    for (const item of items) {
      const target = item.status === "upcoming" ? 18 : Math.ceil((item.made * 1.25) / 10) * 10;
      itemInsert.run(
        item.id,
        "platform",
        platform,
        item.group,
        item.name,
        item.made >= target && item.made > 0 ? "completed" : item.status,
        target,
        item.made,
        item.sort,
      );
    }
  }

  /* --- Campaigns: no daily target, but clips still carry a date ---------- */

  CAMPAIGNS.forEach((campaign, index) => {
    const itemId = uid("item");
    itemInsert.run(
      itemId,
      "campaign",
      null,
      null,
      campaign.name,
      campaign.status,
      campaign.target,
      campaign.made,
      index,
    );
    for (let n = 0; n < campaign.made; n++) {
      addClip(
        "item",
        itemId,
        `https://x.com/${slug(campaign.name)}/status/${nextUrlId()}`,
        DATES[n % DATES.length],
      );
    }
  });

  /* --- Strategies and reports ------------------------------------------- */

  const strategyInsert = stmt(
    `INSERT INTO strategies (id, title, description, status, platform, selected,
       report_reach, report_top_clip, report_verdict, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  STRATEGIES.forEach((s, index) => {
    strategyInsert.run(
      uid("strat"),
      s.title,
      s.description,
      s.status,
      s.platform,
      s.selected,
      s.report?.reach ?? null,
      s.report?.topClip ?? null,
      s.report?.verdict ?? null,
      index,
    );
  });

  const reportInsert = stmt(
    "INSERT INTO reports (id, week, summary, posted_date) VALUES (?, ?, ?, ?)",
  );
  REPORTS.forEach((r) => reportInsert.run(uid("rep"), r.week, r.summary, r.postedDate));
}

/* -------------------------------------------------------------------- run */

const hasContent =
  (await count("SELECT COUNT(*) AS n FROM niches")) > 0 ||
  (await count("SELECT COUNT(*) AS n FROM items")) > 0;

if (RESET_CONTENT) clearContent();
if (RESET_CONTENT || !hasContent) seedContent();
await flush();

const issued = await seedAdmins();
await flush();

const counts = {
  niches: await count("SELECT COUNT(*) AS n FROM niches"),
  accounts: await count("SELECT COUNT(*) AS n FROM accounts"),
  items: await count("SELECT COUNT(*) AS n FROM items"),
  clips: await count("SELECT COUNT(*) AS n FROM clips"),
  days: await count("SELECT COUNT(DISTINCT clip_date) AS n FROM clips"),
  strategies: await count("SELECT COUNT(*) AS n FROM strategies"),
  reports: await count("SELECT COUNT(*) AS n FROM reports"),
  users: await count("SELECT COUNT(*) AS n FROM users"),
};

console.log(`\nDatabase: ${url}`);
console.log(
  `Seeded: ${counts.niches} niches, ${counts.accounts} X accounts, ${counts.items} items, ` +
    `${counts.clips} clips across ${counts.days} days, ${counts.strategies} strategies, ` +
    `${counts.reports} reports, ${counts.users} admins.`,
);

if (issued.length > 0) {
  console.log("\n=== ADMIN CREDENTIALS — SHOWN ONCE, STORE THEM NOW ===\n");
  const width = Math.max(...issued.map((i) => i.username.length));
  for (const { username, password } of issued) {
    console.log(`  ${username.padEnd(width)}   ${password}`);
  }
  console.log(
    "\nOnly scrypt hashes are stored. There is no way to print these again —\n" +
      "re-run with --reset-passwords to issue new ones. Each admin can change\n" +
      "their own password in the app from the account menu.\n",
  );
} else {
  console.log(
    "\nNo new credentials issued (all admins already exist).\n" +
      "Use `npm run seed -- --reset-passwords` to issue fresh ones.\n",
  );
}

db.close();

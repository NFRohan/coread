import { checkUserkey, clearCookie, hashKey, md5hex, newSalt, pageUser, sessionCookie, syncUser } from "./auth";
import { getFlag, json, nowSec, partnersOf, people, person, setFlag } from "./config";
import { logActivity, push, pushConfigured } from "./notify";
import { backfillCovers, coverForWish, setCover } from "./covers";
import { bookSections, live, sessionDetail } from "./detail";
import { addWish, library, removeWish, updateEntry } from "./library";
import { buildState, weeklyRecap } from "./stats";
import { afterPush, recordPush, type Push } from "./track";

const MAX_BODY = 16 * 1024;
const NUDGE_COOLDOWN = 10 * 60;

const unauthorized = () => json({ code: 2001, message: "Unauthorized" }, 401);

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY) return null;
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown, max = 512) => (typeof v === "string" && v.length <= max ? v : null);

// ---------------- KOReader sync protocol (what Readest talks to) ----------------

async function createUser(env: Env, req: Request): Promise<Response> {
  const body = await readJson(req);
  const username = str(body?.username, 64);
  const userkey = str(body?.password, 64);
  if (!username || !userkey) return json({ code: 2003, message: "Invalid request" }, 400);
  if (!person(env, username)) return json({ code: 2005, message: "Registration is closed for this username" }, 403);
  const exists = await env.DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(username).first();
  if (exists) return json({ code: 2002, message: "Username is already registered." }, 402);
  const salt = newSalt();
  await env.DB.prepare("INSERT INTO users (username, key_hash, salt, created_at) VALUES (?, ?, ?, ?)")
    .bind(username, await hashKey(salt, userkey), salt, nowSec(env))
    .run();
  return json({ username }, 201);
}

async function putProgress(env: Env, req: Request, ctx: ExecutionContext, user: string): Promise<Response> {
  const body = await readJson(req);
  const document = str(body?.document, 128);
  if (!body || !document) return json({ code: 2003, message: "Invalid request" }, 400);
  const pct = typeof body.percentage === "number" && Number.isFinite(body.percentage) ? Math.min(Math.max(body.percentage, 0), 1) : null;
  const progress = str(body.progress, 2048);
  const device = str(body.device, 128);
  const deviceId = str(body.device_id, 128);
  const ts = nowSec(env, req);

  // Did the position actually change? Readest also pushes on focus/blur and re-syncs, with the same position.
  const prior = await env.DB.prepare("SELECT progress, percentage FROM progress WHERE username = ? AND document = ?")
    .bind(user, document)
    .first<{ progress: string | null; percentage: number | null }>();
  const moved = !prior || prior.progress !== progress || Math.abs((prior.percentage ?? -1) - (pct ?? -1)) > 1e-9;
  const p: Push = { document, progress, percentage: pct, device, deviceKey: deviceId || device || "unknown", moved };

  await env.DB.prepare(
    `INSERT INTO progress (username, document, progress, percentage, device, device_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(username, document) DO UPDATE SET progress = excluded.progress, percentage = excluded.percentage,
       device = excluded.device, device_id = excluded.device_id, timestamp = excluded.timestamp`,
  ).bind(user, document, p.progress, p.percentage, p.device, deviceId, ts).run();

  const meta = body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : null;
  if (meta && str(meta.title, 512)) {
    await env.DB.prepare(
      `INSERT INTO books (document, title, authors, filename, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(document) DO UPDATE SET title = excluded.title, authors = excluded.authors, filename = excluded.filename, updated_at = excluded.updated_at`,
    ).bind(document, str(meta.title, 512), str(meta.authors, 1024), str(meta.filename, 512), ts).run();
    ctx.waitUntil(backfillCovers(env, ts, 2).catch((e) => console.error(JSON.stringify({ msg: "cover backfill failed", error: String(e) }))));
  }

  const outcome = await recordPush(env, user, p, ts);
  const origin = new URL(req.url).origin;
  ctx.waitUntil(
    afterPush(env, user, p, outcome, ts, origin).catch((e) =>
      console.error(JSON.stringify({ msg: "afterPush failed", user, error: String(e) })),
    ),
  );
  return json({ document, timestamp: ts });
}

async function getProgress(env: Env, user: string, document: string): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT document, progress, percentage, device, device_id, timestamp FROM progress WHERE username = ? AND document = ?",
  ).bind(user, document).first();
  return json(row ?? {});
}

// ---------------- companion page API ----------------

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  return !origin || origin === new URL(req.url).origin;
}

async function login(env: Env, req: Request): Promise<Response> {
  const body = await readJson(req);
  const username = str(body?.username, 64);
  const password = str(body?.password, 256);
  if (!username || !password) return json({ error: "Enter your username and password." }, 400);
  if (!person(env, username) || !(await checkUserkey(env, username, await md5hex(password)))) {
    return json({ error: "Wrong username or password. (Connect Readest to this server first to create your account.)" }, 401);
  }
  return json({ ok: true }, 200, { "set-cookie": await sessionCookie(env, username, nowSec(env)) });
}

async function nudge(env: Env, req: Request, user: string): Promise<Response> {
  const now = nowSec(env, req);
  const key = `nudge:${user}`;
  const flag = await getFlag(env, key);
  if (flag && now - flag.updated_at < NUDGE_COOLDOWN) {
    return json({ ok: false, wait_s: NUDGE_COOLDOWN - (now - flag.updated_at) }, 429);
  }
  await setFlag(env, key, "1", now);
  const me = person(env, user);
  const text = `${me?.name ?? user} wants to read together`;
  await logActivity(env, { ts: now, kind: "nudge", actor: user, text });
  await push(env, partnersOf(env, user), { title: "👋 " + text, message: "Grab your book?", tags: ["wave"], priority: 4 }, new URL(req.url).origin);
  return json({ ok: true });
}

/** Name a book by hand (for clients that don't send document metadata). A later metadata push replaces it. */
async function nameBook(env: Env, req: Request, ctx: ExecutionContext, user: string, document: string): Promise<Response> {
  const body = await readJson(req);
  const title = str(body?.title, 200)?.trim();
  const authors = str(body?.authors, 300)?.trim() || null;
  if (!title) return json({ error: "Give the book a title." }, 400);
  const known = await env.DB.prepare("SELECT 1 FROM progress WHERE document = ? LIMIT 1").bind(document).first();
  if (!known) return json({ error: "Unknown book" }, 404);
  const now = nowSec(env, req);
  await env.DB.prepare(
    `INSERT INTO books (document, title, authors, filename, updated_at) VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT(document) DO UPDATE SET title = excluded.title, authors = COALESCE(excluded.authors, books.authors), updated_at = excluded.updated_at`,
  ).bind(document, title, authors, now).run();
  await logActivity(env, { ts: now, kind: "named", actor: user, document, text: `${person(env, user)?.name ?? user} named a book "${title}"` });
  ctx.waitUntil(backfillCovers(env, now, 2).catch((e) => console.error(JSON.stringify({ msg: "cover backfill failed", error: String(e) }))));
  return json({ ok: true, title, authors });
}

// ---------------- router ----------------

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const m = req.method;

  if (path === "/healthcheck" && m === "GET") return json({ state: "OK" });
  if (path === "/users/create" && m === "POST") return createUser(env, req);
  if (path === "/users/auth" && m === "GET") {
    return (await syncUser(env, req)) ? json({ authorized: "OK" }) : unauthorized();
  }
  if (path === "/syncs/progress" && m === "PUT") {
    const user = await syncUser(env, req);
    return user ? putProgress(env, req, ctx, user) : unauthorized();
  }
  if (path.startsWith("/syncs/progress/") && m === "GET") {
    const user = await syncUser(env, req);
    const doc = decodeURIComponent(path.slice("/syncs/progress/".length));
    return user ? getProgress(env, user, doc) : unauthorized();
  }

  if (path.startsWith("/api/")) {
    if (m !== "GET" && !sameOrigin(req)) return json({ error: "Bad origin" }, 403);
    if (path === "/api/login" && m === "POST") return login(env, req);
    if (path === "/api/logout" && m === "POST") return json({ ok: true }, 200, { "set-cookie": clearCookie() });
    const user = await pageUser(env, req, nowSec(env));
    if (!user || !person(env, user)) return json({ error: "Not signed in" }, 401);
    if (path === "/api/state" && m === "GET") {
      ctx.waitUntil(backfillCovers(env, nowSec(env)).catch((e) => console.error(JSON.stringify({ msg: "cover backfill failed", error: String(e) }))));
      return json(await buildState(env, user, nowSec(env, req)));
    }
    if (path === "/api/nudge" && m === "POST") return nudge(env, req, user);
    if (path === "/api/live" && m === "GET") return json(await live(env, nowSec(env, req)));
    if (path === "/api/settings" && m === "GET") {
      const me = person(env, user);
      const { results: devices } = await env.DB.prepare("SELECT label, created_at, last_ok FROM push_subs WHERE username = ? ORDER BY created_at")
        .bind(user)
        .all();
      return json({
        username: user,
        name: me?.name ?? user,
        push_key: pushConfigured(env) ? env.VAPID_PUBLIC_KEY : null,
        push_devices: devices,
        server_url: url.origin,
        partners: partnersOf(env, user).map((p) => p.name),
      });
    }
    if (path === "/api/push/subscribe" && m === "POST") {
      const body = await readJson(req);
      const endpoint = str(body?.endpoint, 1024);
      const keys = body?.keys && typeof body.keys === "object" ? (body.keys as Record<string, unknown>) : null;
      const p256dh = str(keys?.p256dh, 128);
      const auth = str(keys?.auth, 64);
      let https = false;
      try { https = !!endpoint && new URL(endpoint).protocol === "https:"; } catch { https = false; }
      if (!endpoint || !https || !p256dh || !auth) return json({ error: "Invalid subscription" }, 400);
      await env.DB.prepare(
        `INSERT INTO push_subs (endpoint, username, p256dh, auth, label, created_at, fails) VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(endpoint) DO UPDATE SET username = excluded.username, p256dh = excluded.p256dh, auth = excluded.auth,
           label = COALESCE(excluded.label, push_subs.label), fails = 0`,
      ).bind(endpoint, user, p256dh, auth, str(body?.label, 80), nowSec(env, req)).run();
      return json({ ok: true });
    }
    if (path === "/api/push/unsubscribe" && m === "POST") {
      const body = await readJson(req);
      const endpoint = str(body?.endpoint, 1024);
      if (!endpoint) return json({ error: "Invalid request" }, 400);
      await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ? AND username = ?").bind(endpoint, user).run();
      return json({ ok: true });
    }
    if (path === "/api/test-notify" && m === "POST") {
      const now = nowSec(env, req);
      const key = `testnotify:${user}`;
      const flag = await getFlag(env, key);
      if (flag && now - flag.updated_at < 30) return json({ ok: false, wait_s: 30 - (now - flag.updated_at) }, 429);
      const me = person(env, user);
      if (!me) return unauthorized();
      await setFlag(env, key, "1", now);
      const [res] = await push(env, [me], { title: "🔔 coread test", message: "Notifications are working. You'll hear when your partner reads.", tags: ["test"] }, url.origin);
      if (!res?.ok) return json({ ok: false, error: `Couldn't deliver it: ${res?.error ?? "unknown error"}` }, 502);
      return json({ ok: true, devices: res.devices });
    }
    const sm = /^\/api\/session\/(\d+)$/.exec(path);
    if (sm && m === "GET") {
      const d = await sessionDetail(env, Number(sm[1]));
      return d ? json(d) : json({ error: "No such session" }, 404);
    }
    const bm = /^\/api\/book\/([^/]+)\/sections$/.exec(path);
    if (bm && m === "GET") return json(await bookSections(env, decodeURIComponent(bm[1])));
    const tm = /^\/api\/book\/([^/]+)\/title$/.exec(path);
    if (tm && m === "POST") return nameBook(env, req, ctx, user, decodeURIComponent(tm[1]));
    const cm = /^\/api\/book\/([^/]+)\/cover$/.exec(path);
    if (cm && m === "POST") {
      const body = await readJson(req);
      const raw = typeof body?.url === "string" ? body.url.trim() : null;
      const doc = decodeURIComponent(cm[1]);
      const known = await env.DB.prepare("SELECT 1 FROM progress WHERE document = ? LIMIT 1").bind(doc).first();
      if (!known) return json({ error: "Unknown book" }, 404);
      if (raw) {
        let ok = false;
        try { ok = raw.length <= 500 && new URL(raw).protocol === "https:"; } catch { ok = false; }
        if (!ok) return json({ error: "Paste an https:// image link." }, 400);
      }
      const now = nowSec(env, req);
      await setCover(env, doc, raw || null, now);
      if (!raw) ctx.waitUntil(backfillCovers(env, now, 2).catch(() => undefined));
      return json({ ok: true });
    }

    // shelves
    const origin = url.origin;
    if (path === "/api/library" && m === "GET") return json(await library(env, user, nowSec(env, req)));
    const lm = /^\/api\/library\/([^/]+)$/.exec(path);
    if (lm && m === "POST") {
      const body = await readJson(req);
      if (!body) return json({ error: "Invalid request" }, 400);
      const r = await updateEntry(env, user, decodeURIComponent(lm[1]), body, nowSec(env, req), origin);
      return json(r.body, r.status);
    }
    if (path === "/api/wishlist" && m === "POST") {
      const body = await readJson(req);
      if (!body) return json({ error: "Invalid request" }, 400);
      const r = await addWish(env, user, body, nowSec(env, req), origin);
      const id = (r.body as { id?: number }).id;
      if (r.status === 201 && id && typeof body.title === "string") {
        ctx.waitUntil(coverForWish(env, id, body.title.trim(), typeof body.authors === "string" ? body.authors.trim() : null).catch(() => undefined));
      }
      return json(r.body, r.status);
    }
    const wm = /^\/api\/wishlist\/(\d+)$/.exec(path);
    if (wm && m === "DELETE") {
      const r = await removeWish(env, user, Number(wm[1]));
      return json(r.body, r.status);
    }
  }
  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      console.error(JSON.stringify({ msg: "unhandled error", path: new URL(req.url).pathname, error: String(e), stack: (e as Error).stack }));
      return json({ code: 2000, message: "Server error" }, 500);
    }
  },

  async scheduled(controller, env, ctx): Promise<void> {
    if (!people(env).length) return;
    ctx.waitUntil(weeklyRecap(env, Math.floor(controller.scheduledTime / 1000)));
  },
} satisfies ExportedHandler<Env>;

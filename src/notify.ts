import type { Person } from "./config";
import { encrypt, vapidAuth, type Subscription } from "./webpush";

export interface Note {
  title: string;
  message: string;
  tags?: string[];   // first tag doubles as the notification "tag" (same-kind notifications replace each other)
  priority?: number; // 1–5, default 3; 4+ is sent as high urgency
}

export interface PushResult {
  username: string;
  ok: boolean;       // at least one of this person's devices accepted it
  devices: number;   // subscriptions tried
  error?: string;
}

const MAX_FAILS = 5; // drop a subscription after this many failed deliveries in a row

export async function logActivity(
  env: Env,
  a: { ts: number; kind: string; actor?: string; document?: string; text: string },
): Promise<void> {
  await env.DB.prepare("INSERT INTO activity (ts, kind, actor, document, text) VALUES (?, ?, ?, ?, ?)")
    .bind(a.ts, a.kind, a.actor ?? null, a.document ?? null, a.text)
    .run();
}

export function pushConfigured(env: Env): boolean {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

/** One delivery to one browser. Returns "ok", "gone" (subscription expired) or an error string. */
async function deliver(env: Env, sub: Subscription, body: Uint8Array, urgency: string, subject: string, now: number): Promise<"ok" | "gone" | string> {
  const payload = await encrypt(sub, body);
  if (env.PUSH_DRY_RUN === "1") return "ok";
  const auth = await vapidAuth(sub.endpoint, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, subject, now);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: auth,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(24 * 3600),
      urgency,
    },
    body: payload,
    signal: AbortSignal.timeout(8000),
  });
  if (res.ok) return "ok";
  if (res.status === 404 || res.status === 410) return "gone";
  return `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
}

/** Send a notification to every device each recipient turned notifications on for. */
export async function push(env: Env, to: Person[], note: Note, clickUrl?: string): Promise<PushResult[]> {
  if (!pushConfigured(env)) {
    console.warn(JSON.stringify({ msg: "push skipped: VAPID keys not set" }));
    return to.map((p) => ({ username: p.username, ok: false, devices: 0, error: "push isn't set up on the server (VAPID keys missing)" }));
  }
  const now = Math.floor(Date.now() / 1000);
  const body = new TextEncoder().encode(JSON.stringify({
    title: note.title,
    body: note.message,
    tag: note.tags?.[0] ?? "coread",
    url: clickUrl ? new URL("/", clickUrl).href : "/",
  }));
  const urgency = (note.priority ?? 3) >= 4 ? "high" : "normal";
  // VAPID "sub" must be a mailto: or https: contact; the app's own URL is a fine default.
  const subject = env.VAPID_SUBJECT || (clickUrl ? new URL(clickUrl).origin : "mailto:coread@example.com");

  return Promise.all(
    to.map(async (p): Promise<PushResult> => {
      const { results: subs } = await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subs WHERE username = ?")
        .bind(p.username)
        .all<Subscription>();
      if (!subs.length) return { username: p.username, ok: false, devices: 0, error: "notifications aren't turned on on any device" };

      const outcomes = await Promise.all(
        subs.map(async (s) => {
          let r: string;
          try {
            r = await deliver(env, s, body, urgency, subject, now);
          } catch (e) {
            r = String(e);
          }
          if (r === "ok") {
            await env.DB.prepare("UPDATE push_subs SET last_ok = ?, fails = 0 WHERE endpoint = ?").bind(now, s.endpoint).run();
          } else if (r === "gone") {
            await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(s.endpoint).run();
            console.log(JSON.stringify({ msg: "push subscription expired, removed", to: p.username }));
          } else {
            console.error(JSON.stringify({ msg: "push delivery failed", to: p.username, host: new URL(s.endpoint).host, error: r }));
            await env.DB.prepare("UPDATE push_subs SET fails = fails + 1 WHERE endpoint = ?").bind(s.endpoint).run();
            await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ? AND fails >= ?").bind(s.endpoint, MAX_FAILS).run();
          }
          if (env.PUSH_DRY_RUN === "1") console.log(JSON.stringify({ msg: "push dry run", to: p.username, title: note.title, message: note.message }));
          return r;
        }),
      );
      const ok = outcomes.includes("ok");
      return { username: p.username, ok, devices: subs.length, error: ok ? undefined : outcomes.find((o) => o !== "ok") };
    }),
  );
}

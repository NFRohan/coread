export interface Person {
  username: string;
  name: string;
  tz?: string;    // IANA time zone for this person's stats
}

export const SESSION_GAP = 10 * 60;   // seconds between pushes that still count as one session
export const READING_WINDOW = 5 * 60; // last push within this → "reading now"
export const PAGE_CREDIT = 60;        // seconds credited for the last page of a session

export function people(env: Env): Person[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.USERS);
  } catch {
    throw new Error("USERS secret is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("USERS secret must be a JSON array");
  return parsed.map((p: unknown, i) => {
    if (!p || typeof p !== "object" || typeof (p as Person).username !== "string") {
      throw new Error(`USERS[${i}] needs a "username"`);
    }
    const { username, name, tz } = p as Person; // an old "topic" field (ntfy) is ignored
    return { username, name: typeof name === "string" && name ? name : username, tz };
  });
}

export function person(env: Env, username: string): Person | undefined {
  return people(env).find((p) => p.username === username);
}

export function partnersOf(env: Env, username: string): Person[] {
  return people(env).filter((p) => p.username !== username);
}

export function spoilerGap(env: Env): number {
  const v = Number(env.SPOILER_GAP);
  return Number.isFinite(v) && v > 0 ? v : 0.05;
}

export function tzOf(env: Env, p: Person): string {
  return p.tz || env.TIMEZONE || "Asia/Dhaka";
}

/** Current time in seconds. Tests may set it with X-Coread-Now when ALLOW_TIME_OVERRIDE=1 (local dev only). */
export function nowSec(env: Env, req?: Request): number {
  if (req && env.ALLOW_TIME_OVERRIDE === "1") {
    const o = Number(req.headers.get("x-coread-now"));
    if (Number.isFinite(o) && o > 0) return Math.floor(o);
  }
  return Math.floor(Date.now() / 1000);
}

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export async function getFlag(env: Env, key: string): Promise<{ value: string | null; updated_at: number } | null> {
  return env.DB.prepare("SELECT value, updated_at FROM flags WHERE key = ?").bind(key).first();
}

export async function setFlag(env: Env, key: string, value: string | null, ts: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO flags (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).bind(key, value, ts).run();
}

export async function clearFlag(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM flags WHERE key = ?").bind(key).run();
}

export async function bookTitle(env: Env, document: string): Promise<string> {
  const row = await env.DB.prepare("SELECT title FROM books WHERE document = ?").bind(document).first<{ title: string | null }>();
  return row?.title || "an untitled book";
}

/** EPUB position → section (spine item) number, e.g. "/body/DocFragment[12]/body/p[3]" → 12. */
export function sectionOf(progress: string | null | undefined): number | null {
  if (!progress) return null;
  const m = /DocFragment\[(\d+)\]/.exec(progress);
  return m ? Number(m[1]) : null;
}

export function deviceKind(name: string | null): "phone" | "tablet" | "computer" | "device" {
  const n = (name || "").toLowerCase();
  if (/tab|pad/.test(n)) return "tablet";
  if (/phone|mobile|android|ios/.test(n)) return "phone";
  if (/pc|desktop|windows|mac|linux|laptop|computer/.test(n)) return "computer";
  return "device";
}

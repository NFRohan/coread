import {
  PAGE_CREDIT, READING_WINDOW, SESSION_GAP, bookTitle, clearFlag, getFlag, partnersOf, person, sectionOf, setFlag, spoilerGap,
} from "./config";
import { logActivity, push } from "./notify";

const STARTED_GAP = 45 * 60;      // only announce "started reading" after a real break
const TOGETHER_COOLDOWN = 2 * 3600;

export interface Push {
  document: string;
  progress: string | null;
  percentage: number | null;
  device: string | null;
  deviceKey: string; // device_id from the client, else the device name
  moved: boolean;    // the position changed since the last push for this person and book
}

interface SessionRow {
  id: number;
  document: string;
  end_ts: number;
  end_section: number | null;
}

export interface PushOutcome {
  newSession: boolean;
  prevEnd: number | null;     // end of the user's previous session (any book, any device), if any
  prevSection: number | null; // section before this push, within a continuing session
  section: number | null;
}

/**
 * Store the push and fold it into the reading session of the device that sent it.
 * Sessions are per device, so a phone and a laptop never split each other's sessions.
 * Pushes that didn't move the position (focusing or leaving the app, an idle device re-syncing)
 * are kept as history but never start or extend a session.
 */
export async function recordPush(env: Env, username: string, p: Push, ts: number): Promise<PushOutcome> {
  const section = sectionOf(p.progress);
  const latest = await env.DB.prepare("SELECT MAX(end_ts) AS t FROM sessions WHERE username = ?").bind(username).first<{ t: number | null }>();
  const last = await env.DB.prepare(
    "SELECT id, document, end_ts, end_section FROM sessions WHERE username = ? AND device_id = ? ORDER BY end_ts DESC LIMIT 1",
  ).bind(username, p.deviceKey).first<SessionRow>();

  const continuing = !!last && last.document === p.document && ts >= last.end_ts && ts - last.end_ts <= SESSION_GAP;
  let sessionId: number | null = null;
  if (p.moved && continuing) {
    sessionId = last.id;
    await env.DB.prepare("UPDATE sessions SET end_ts = ?, end_pct = ?, end_section = ?, device = ?, pushes = pushes + 1 WHERE id = ?")
      .bind(ts, p.percentage, section, p.device, last.id)
      .run();
  } else if (p.moved) {
    const row = await env.DB.prepare(
      "INSERT INTO sessions (username, document, device, device_id, start_ts, end_ts, start_pct, end_pct, start_section, end_section) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    ).bind(username, p.document, p.device, p.deviceKey, ts, ts, p.percentage, p.percentage, section, section).first<{ id: number }>();
    if (!row) throw new Error("session insert returned no id");
    sessionId = row.id;
  }
  await env.DB.prepare(
    "INSERT INTO events (session_id, username, document, percentage, section, device, device_id, moved, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(sessionId, username, p.document, p.percentage, section, p.device, p.deviceKey, p.moved ? 1 : 0, ts).run();

  return {
    newSession: p.moved && !continuing,
    prevEnd: latest?.t ?? null,
    prevSection: p.moved && continuing ? last.end_section : null,
    section,
  };
}

/** Notifications that follow from a push. Runs after the sync response has been sent. */
export async function afterPush(env: Env, username: string, p: Push, o: PushOutcome, ts: number, origin: string): Promise<void> {
  const me = person(env, username);
  // A push that didn't move the position (focus/blur, an idle device re-syncing) never means anything new happened.
  if (!me || !p.moved) return;
  const partners = partnersOf(env, username);
  const title = await bookTitle(env, p.document);

  // 1. A brand-new book (first push ever for this person and file) — replaces "started reading" for that push.
  const seen = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE username = ? AND document = ?")
    .bind(username, p.document)
    .first<{ n: number }>();
  if (o.newSession && seen?.n === 1) {
    const text = `${me.name} started a new book: ${title}`;
    await logActivity(env, { ts, kind: "newbook", actor: username, document: p.document, text });
    await push(env, partners, { title: "📚 " + text, message: "See it on their shelf in coread.", tags: ["books"] }, origin);
  } else if (o.newSession && (o.prevEnd === null || ts - o.prevEnd >= STARTED_GAP)) {
    // Started reading (after a break of 45+ minutes).
    const text = `${me.name} started reading ${title}`;
    await logActivity(env, { ts, kind: "started", actor: username, document: p.document, text });
    await push(env, partners, { title: "📖 " + text, message: "Open coread to see where they are.", tags: ["books"] }, origin);
  }

  // 2. Finished a section (moved exactly one section forward within the session).
  if (o.prevSection !== null && o.section !== null && o.section === o.prevSection + 1) {
    const text = `${me.name} finished section ${o.prevSection} of ${title}`;
    await logActivity(env, { ts, kind: "section", actor: username, document: p.document, text });
    await push(env, partners, { title: "✅ " + text, message: `Now on section ${o.section}.`, tags: ["white_check_mark"] }, origin);
  }

  // 3. Finished the book.
  if ((p.percentage ?? 0) >= 0.995) {
    const key = `finished:${username}:${p.document}`;
    if (!(await getFlag(env, key))) {
      await setFlag(env, key, "1", ts);
      const text = `${me.name} finished ${title}!`;
      await logActivity(env, { ts, kind: "finished", actor: username, document: p.document, text });
      await push(env, partners, { title: "🎉 " + text, message: "Time to talk about the ending.", tags: ["tada"], priority: 4 }, origin);
    }
  }

  for (const partner of partners) {
    // 4. Reading together right now.
    const theirs = await env.DB.prepare("SELECT end_ts FROM sessions WHERE username = ? ORDER BY end_ts DESC LIMIT 1")
      .bind(partner.username)
      .first<{ end_ts: number }>();
    if (theirs && ts - theirs.end_ts <= READING_WINDOW) {
      const key = `together:${[username, partner.username].sort().join(":")}`;
      const flag = await getFlag(env, key);
      if (!flag || ts - flag.updated_at >= TOGETHER_COOLDOWN) {
        await setFlag(env, key, "1", ts);
        const text = `${me.name} and ${partner.name} are reading at the same time`;
        await logActivity(env, { ts, kind: "together", actor: username, text });
        await push(env, [me, partner], { title: "💞 You're both reading right now", message: text, tags: ["two_hearts"] }, origin);
      }
    }

    // 5. Spoiler guard: warn whoever is more than SPOILER_GAP ahead in a shared book (once per crossing).
    if (p.percentage === null) continue;
    const other = await env.DB.prepare("SELECT percentage FROM progress WHERE username = ? AND document = ?")
      .bind(partner.username, p.document)
      .first<{ percentage: number | null }>();
    if (!other || other.percentage === null) continue;
    const gap = p.percentage - other.percentage;
    const limit = spoilerGap(env);
    for (const [ahead, behind, g] of [[me, partner, gap], [partner, me, -gap]] as const) {
      const key = `spoiler:${p.document}:${ahead.username}`;
      if (g > limit) {
        if (!(await getFlag(env, key))) {
          await setFlag(env, key, "1", ts);
          const pts = Math.round(g * 100);
          const text = `${ahead.name} is ${pts}% ahead of ${behind.name} in ${title}`;
          await logActivity(env, { ts, kind: "spoiler", actor: ahead.username, document: p.document, text });
          await push(env, [ahead], {
            title: "🛑 Spoiler zone",
            message: `You're ${pts}% ahead of ${behind.name} in ${title}. Careful what you say!`,
            tags: ["no_entry"],
          }, origin);
        }
      } else if (g < limit / 2) {
        await clearFlag(env, key);
      }
    }
  }
}

/** Seconds of reading credited to a session. */
export function sessionSeconds(start: number, end: number): number {
  return end - start + PAGE_CREDIT;
}

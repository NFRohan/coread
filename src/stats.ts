import { PAGE_CREDIT, READING_WINDOW, deviceKind, people, sectionOf, spoilerGap, tzOf } from "./config";
import { coverMap, median, pageTimesSince, presenceOf, recentSessions, titleMap } from "./detail";
import { logActivity, push } from "./notify";
import { FINISHED_PCT, statusOf } from "./library";

const DAY = 86400;

interface Session {
  username: string;
  document: string;
  device: string | null;
  start_ts: number;
  end_ts: number;
  start_pct: number | null;
  end_pct: number | null;
}

// Formatters are immutable and reused across requests (not request state).
const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Seconds to add to a UTC timestamp to get local wall-clock time in tz. */
export function offsetSec(tz: string, ts: number): number {
  const parts = Object.fromEntries(fmt(tz).formatToParts(new Date(ts * 1000)).map((p) => [p.type, p.value]));
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second) / 1000;
  return local - ts;
}

const localDay = (tz: string, ts: number) => Math.floor((ts + offsetSec(tz, ts)) / DAY);
const dayLabel = (day: number) => new Date(day * DAY * 1000).toISOString().slice(0, 10);
const mondayIndex = (day: number) => (((day + 4) % 7) + 6) % 7; // 1970-01-01 was a Thursday; Monday → 0


interface PersonStats {
  today_min: number;
  week_min: number;      // since Monday, local time
  streak_days: number;   // consecutive days with ≥5 minutes
  last14: { day: string; min: number }[];
  heat: number[][];      // [Mon..Sun][0..23] minutes over the last 28 days
  sessions_7d: number;
  avg_session_min: number;
  speed_pct_per_hour: number | null;
}

function personStats(tz: string, sessions: Session[], now: number): PersonStats {
  const byDay = new Map<number, number>();
  const heat = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const today = localDay(tz, now);
  // Merge sessions first: reading on two devices at the same moment counts once.
  for (const [start, end] of intervals(sessions, 0)) {
    const off = offsetSec(tz, start);
    for (let t = start; t < end; t += 60) {
      const sec = Math.min(60, end - t);
      const local = t + off;
      const day = Math.floor(local / DAY);
      byDay.set(day, (byDay.get(day) ?? 0) + sec / 60);
      if (day > today - 28) heat[mondayIndex(day)][Math.floor((local % DAY) / 3600)] += sec / 60;
    }
  }
  const weekStart = today - mondayIndex(today);
  let week = 0;
  for (let d = weekStart; d <= today; d++) week += byDay.get(d) ?? 0;
  let streak = 0;
  for (let d = (byDay.get(today) ?? 0) >= 5 ? today : today - 1; (byDay.get(d) ?? 0) >= 5; d--) streak++;

  const recent = sessions.filter((s) => s.start_ts >= now - 7 * DAY);
  const month = sessions.filter((s) => s.start_ts >= now - 28 * DAY);
  const avg = month.length ? month.reduce((a, s) => a + (s.end_ts - s.start_ts + PAGE_CREDIT), 0) / month.length / 60 : 0;
  return {
    today_min: Math.round(byDay.get(today) ?? 0),
    week_min: Math.round(week),
    streak_days: streak,
    last14: Array.from({ length: 14 }, (_, i) => today - 13 + i).map((d) => ({ day: dayLabel(d), min: Math.round(byDay.get(d) ?? 0) })),
    heat: heat.map((row) => row.map((m) => Math.round(m))),
    sessions_7d: recent.length,
    avg_session_min: Math.round(avg),
    speed_pct_per_hour: speed(month),
  };
}

/** Average progress per reading hour, from sessions long enough to measure (≥3 min, moving forward). */
function speed(sessions: Session[]): number | null {
  let pct = 0;
  let hours = 0;
  for (const s of sessions) {
    const dur = s.end_ts - s.start_ts;
    const d = (s.end_pct ?? 0) - (s.start_pct ?? 0);
    if (dur >= 180 && d > 0 && d < 0.5) {
      pct += d;
      hours += dur / 3600;
    }
  }
  return hours >= 0.25 ? pct / hours : null;
}

function intervals(sessions: Session[], from: number): [number, number][] {
  const iv = sessions
    .filter((s) => s.end_ts + PAGE_CREDIT > from)
    .map((s) => [Math.max(s.start_ts, from), s.end_ts + PAGE_CREDIT] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of iv) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** Minutes two people were reading at the same moment since `from`. */
function overlapMin(a: Session[], b: Session[], from: number): number {
  const x = intervals(a, from);
  const y = intervals(b, from);
  let i = 0;
  let j = 0;
  let sec = 0;
  while (i < x.length && j < y.length) {
    const lo = Math.max(x[i][0], y[j][0]);
    const hi = Math.min(x[i][1], y[j][1]);
    if (hi > lo) sec += hi - lo;
    if (x[i][1] < y[j][1]) i++;
    else j++;
  }
  return Math.round(sec / 60);
}

async function loadSessions(env: Env, since: number): Promise<Session[]> {
  const { results } = await env.DB.prepare(
    "SELECT username, document, device, start_ts, end_ts, start_pct, end_pct FROM sessions WHERE end_ts >= ? ORDER BY start_ts",
  ).bind(since).all<Session>();
  return results;
}

export async function buildState(env: Env, me: string, now: number) {
  const everyone = people(env);
  const sessions = await loadSessions(env, now - 35 * DAY);
  const of = (u: string) => sessions.filter((s) => s.username === u);

  const { results: titleRows } = await env.DB.prepare("SELECT document, title, authors FROM books").all<{ document: string; title: string | null; authors: string | null }>();
  const titles = new Map(titleRows.map((r) => [r.document, r]));
  const titleOf = (doc: string) => titles.get(doc)?.title || `Untitled book (${doc.slice(0, 6)})`;

  const pageTimes = await pageTimesSince(env, now - 7 * DAY);
  const presenceTitles = await titleMap(env);
  const covers = await coverMap(env);
  const peopleOut = await Promise.all(
    everyone.map(async (p, idx) => {
      return {
        username: p.username,
        name: p.name,
        is_me: p.username === me,
        slot: idx,
        presence: await presenceOf(env, p.username, now, presenceTitles, covers),
        stats: personStats(tzOf(env, p), of(p.username), now),
        pages_7d: { count: pageTimes.get(p.username)?.length ?? 0, sec_per_page: median(pageTimes.get(p.username) ?? []) },
      };
    }),
  );

  const { results: prog } = await env.DB.prepare(
    `SELECT p.username, p.document, p.progress, p.percentage, p.device, p.timestamp, ub.status, ub.finished_at,
       (SELECT MIN(e.ts) FROM events e WHERE e.username = p.username AND e.document = p.document AND e.percentage >= ${FINISHED_PCT}) AS auto_finished_ts
     FROM progress p LEFT JOIN user_books ub ON ub.username = p.username AND ub.document = p.document
     WHERE p.timestamp >= ? ORDER BY p.timestamp DESC`,
  ).bind(now - 120 * DAY).all<{
    username: string; document: string; progress: string | null; percentage: number | null; device: string | null; timestamp: number;
    status: string | null; finished_at: number | null; auto_finished_ts: number | null;
  }>();
  const books = new Map<string, typeof prog>();
  for (const r of prog) {
    if (!everyone.some((p) => p.username === r.username)) continue;
    books.set(r.document, [...(books.get(r.document) ?? []), r]);
  }
  const gapLimit = spoilerGap(env);
  const booksOut = [...books.entries()].map(([doc, rows]) => {
    const readers = rows.map((r) => {
      const sp = speed(sessions.filter((s) => s.username === r.username && s.document === doc)) ?? speed(of(r.username));
      const pct = r.percentage ?? 0;
      const shelf = statusOf({ ...r, last_ts: r.timestamp }, now).status;
      return {
        username: r.username,
        pct,
        done: shelf === "finished" || shelf === "abandoned" ? shelf : null,
        section: sectionOf(r.progress),
        ts: r.timestamp,
        device: r.device,
        eta_hours: sp && pct < 1 ? (1 - pct) / sp : null,
      };
    });
    const mine = readers.find((r) => r.username === me);
    const partner = readers.find((r) => r.username !== me);
    const gap = mine && partner ? mine.pct - partner.pct : null;
    return {
      document: doc,
      title: titleOf(doc),
      named: !!titles.get(doc)?.title,
      cover: covers.get(doc) ?? null,
      authors: titles.get(doc)?.authors ?? null,
      shared: readers.length > 1,
      readers,
      gap,
      spoiler: gap !== null && Math.abs(gap) > gapLimit,
      last_ts: Math.max(...readers.map((r) => r.ts)),
    };
  })
    // "Books" is what's on the go: drop a book once every reader has finished it or put it down (it stays on Shelves).
    .filter((b) => b.readers.some((r) => !r.done))
    .sort((a, b) => Number(b.shared) - Number(a.shared) || b.last_ts - a.last_ts);

  const partner = everyone.find((p) => p.username !== me);
  const meTz = tzOf(env, everyone.find((p) => p.username === me) ?? everyone[0]);
  const todayStart = now - ((now + offsetSec(meTz, now)) % DAY);
  const together = partner
    ? {
        now: peopleOut.every((p) => p.presence.status === "reading"),
        week_min: overlapMin(of(me), of(partner.username), now - 7 * DAY),
        month_min: overlapMin(of(me), of(partner.username), now - 28 * DAY),
        today_min: overlapMin(of(me), of(partner.username), todayStart),
      }
    : null;

  const { results: activity } = await env.DB.prepare("SELECT ts, kind, actor, text FROM activity ORDER BY ts DESC, id DESC LIMIT 25").all();

  const sessionsOut = await recentSessions(env, 30);

  const anyReading = await env.DB.prepare("SELECT 1 FROM progress LIMIT 1").first();
  return { me, now, spoiler_gap: gapLimit, has_history: !!anyReading, people: peopleOut, together, books: booksOut, sessions: sessionsOut, activity };
}

const hm = (min: number) => (min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m` : `${min}m`);

/** Sunday recap: last 7 days for everyone, sent to everyone. */
export async function weeklyRecap(env: Env, now: number): Promise<void> {
  const everyone = people(env);
  if (!everyone.length) return;
  const from = now - 7 * DAY;
  const sessions = await loadSessions(env, from);
  const lines: string[] = [];
  const mins = everyone.map((p) => {
    const mine = sessions.filter((s) => s.username === p.username);
    const min = Math.round(intervals(mine, from).reduce((a, [s, e]) => a + (Math.min(e, now + PAGE_CREDIT) - s) / 60, 0));
    const gained = mine.reduce((a, s) => a + Math.max(0, (s.end_pct ?? 0) - (s.start_pct ?? 0)), 0);
    lines.push(`${p.name}: ${hm(min)} in ${mine.length} session${mine.length === 1 ? "" : "s"}, +${Math.round(gained * 100)}% of books`);
    return { p, min };
  });
  if (everyone.length >= 2) {
    const both = overlapMin(
      sessions.filter((s) => s.username === everyone[0].username),
      sessions.filter((s) => s.username === everyone[1].username),
      from,
    );
    lines.push(`Reading together: ${hm(both)}`);
  }
  const top = [...mins].sort((a, b) => b.min - a.min)[0];
  const headline = top.min > 0 ? `${top.p.name} read the most this week` : "A quiet week. Pick a chapter for tonight?";
  const message = lines.join("\n");
  await logActivity(env, { ts: now, kind: "recap", text: `Weekly recap: ${lines.join(" · ")}` });
  await push(env, everyone, { title: `📊 Weekly recap: ${headline}`, message, tags: ["bar_chart"] });
}

export type State = Awaited<ReturnType<typeof buildState>>;

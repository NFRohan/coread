import { PAGE_CREDIT, READING_WINDOW, deviceKind, people } from "./config";

const MAX_GAP = 600;    // longer than 10 minutes between pushes is never one page
const MIN_PAGE = 3;     // faster than this is flicking, not reading
const JUMP = 0.02;      // moving more than 2% of the book at once is a jump, not a page turn
const BACK = -0.001;    // any real move backwards is a jump back

export interface Ev {
  session_id: number | null;
  username: string;
  document: string;
  ts: number;
  percentage: number | null;
  section: number | null;
}

export type PointKind = "start" | "page" | "jump" | "back" | "still";

export interface Point {
  ts: number;
  pct: number | null;
  section: number | null;
  kind: PointKind;
  page_s: number | null; // seconds spent on the previous page, when this push was a page turn
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Classify each push in one session (events in time order).
 * Readest pushes ~5 s after you stop on a page, so the gap between two forward pushes is the time spent on a page.
 * Pushes with no movement (leaving the app, re-syncs) count as "still"; big moves count as jumps.
 */
export function analyse(evs: Ev[]) {
  const points: Point[] = [];
  const pageTimes: number[] = [];
  let jumps = 0;
  evs.forEach((e, i) => {
    if (i === 0) {
      points.push({ ts: e.ts, pct: e.percentage, section: e.section, kind: "start", page_s: null });
      return;
    }
    const prev = evs[i - 1];
    const dt = e.ts - prev.ts;
    const d = (e.percentage ?? 0) - (prev.percentage ?? 0);
    let kind: PointKind;
    let page: number | null = null;
    if (d < BACK) kind = "back";
    else if (d > JUMP) kind = "jump";
    else if (d > 0 && dt >= MIN_PAGE && dt <= MAX_GAP) {
      kind = "page";
      page = dt;
      pageTimes.push(dt);
    } else kind = "still";
    if (kind === "back" || kind === "jump") jumps++;
    points.push({ ts: e.ts, pct: e.percentage, section: e.section, kind, page_s: page });
  });
  return { points, page_times: pageTimes, sec_per_page: median(pageTimes), jumps, pages: pageTimes.length };
}

/** Seconds spent per section: each gap between pushes (capped) goes to the section being read before it. */
export function sectionSeconds(evs: Ev[]): Map<number, number> {
  const out = new Map<number, number>();
  const add = (sec: number | null, s: number) => {
    if (sec !== null) out.set(sec, (out.get(sec) ?? 0) + s);
  };
  evs.forEach((e, i) => {
    const next = evs[i + 1];
    const sameSession = next && next.session_id === e.session_id && next.username === e.username;
    add(e.section, sameSession ? Math.min(next.ts - e.ts, MAX_GAP) : PAGE_CREDIT);
  });
  return out;
}

interface SessionRow {
  id: number;
  username: string;
  document: string;
  device: string | null;
  start_ts: number;
  end_ts: number;
  start_pct: number | null;
  end_pct: number | null;
  start_section: number | null;
  end_section: number | null;
}

async function eventsFor(env: Env, ids: number[]): Promise<Map<number, Ev[]>> {
  const out = new Map<number, Ev[]>();
  if (!ids.length) return out;
  const { results } = await env.DB.prepare(
    `SELECT session_id, username, document, ts, percentage, section FROM events WHERE session_id IN (${ids.map(() => "?").join(",")}) ORDER BY ts, id`,
  ).bind(...ids).all<Ev>();
  for (const e of results) {
    const id = e.session_id ?? -1;
    out.set(id, [...(out.get(id) ?? []), e]);
  }
  return out;
}

function summarise(s: SessionRow, evs: Ev[], titles: Map<string, string>) {
  const a = analyse(evs);
  return {
    id: s.id,
    username: s.username,
    document: s.document,
    title: titles.get(s.document) || `Untitled book (${s.document.slice(0, 6)})`,
    device: s.device,
    device_kind: deviceKind(s.device),
    start_ts: s.start_ts,
    end_ts: s.end_ts,
    minutes: Math.round((s.end_ts - s.start_ts + PAGE_CREDIT) / 60),
    start_pct: s.start_pct,
    end_pct: s.end_pct,
    start_section: s.start_section,
    end_section: s.end_section,
    pushes: evs.length,
    pages: a.pages,
    sec_per_page: a.sec_per_page,
    jumps: a.jumps,
  };
}

export type SessionSummary = ReturnType<typeof summarise>;

export async function coverMap(env: Env): Promise<Map<string, string>> {
  const { results } = await env.DB.prepare("SELECT document, cover_url FROM books WHERE cover_url IS NOT NULL").all<{ document: string; cover_url: string }>();
  return new Map(results.map((r) => [r.document, r.cover_url]));
}

export async function titleMap(env: Env): Promise<Map<string, string>> {
  const { results } = await env.DB.prepare("SELECT document, title FROM books").all<{ document: string; title: string | null }>();
  return new Map(results.filter((r) => r.title).map((r) => [r.document, r.title as string]));
}

export async function recentSessions(env: Env, limit = 30): Promise<SessionSummary[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, username, document, device, start_ts, end_ts, start_pct, end_pct, start_section, end_section FROM sessions ORDER BY start_ts DESC LIMIT ?",
  ).bind(limit).all<SessionRow>();
  const evs = await eventsFor(env, results.map((r) => r.id));
  const titles = await titleMap(env);
  return results.map((s) => summarise(s, evs.get(s.id) ?? [], titles));
}

export async function sessionDetail(env: Env, id: number) {
  const s = await env.DB.prepare(
    "SELECT id, username, document, device, start_ts, end_ts, start_pct, end_pct, start_section, end_section FROM sessions WHERE id = ?",
  ).bind(id).first<SessionRow>();
  if (!s) return null;
  const evs = (await eventsFor(env, [id])).get(id) ?? [];
  return { ...summarise(s, evs, await titleMap(env)), points: analyse(evs).points };
}

/** Time per page over a window, per user: median plus the samples' distribution. */
export async function pageTimesSince(env: Env, since: number): Promise<Map<string, number[]>> {
  const { results } = await env.DB.prepare(
    "SELECT session_id, username, document, ts, percentage, section FROM events WHERE ts >= ? ORDER BY username, session_id, ts, id",
  ).bind(since).all<Ev>();
  const out = new Map<string, number[]>();
  let run: Ev[] = [];
  const flush = () => {
    if (run.length) out.set(run[0].username, [...(out.get(run[0].username) ?? []), ...analyse(run).page_times]);
    run = [];
  };
  for (const e of results) {
    if (run.length && (run[0].session_id !== e.session_id || run[0].username !== e.username)) flush();
    run.push(e);
  }
  flush();
  return out;
}

export async function bookSections(env: Env, document: string) {
  const { results } = await env.DB.prepare(
    "SELECT session_id, username, document, ts, percentage, section FROM events WHERE document = ? ORDER BY username, session_id, ts, id",
  ).bind(document).all<Ev>();
  const byUser = new Map<string, Ev[]>();
  for (const e of results) byUser.set(e.username, [...(byUser.get(e.username) ?? []), e]);
  const sections = new Map<number, Record<string, number>>();
  for (const [u, evs] of byUser) {
    for (const [sec, s] of sectionSeconds(evs)) {
      sections.set(sec, { ...(sections.get(sec) ?? {}), [u]: Math.round(s / 60) });
    }
  }
  const title = await env.DB.prepare("SELECT title FROM books WHERE document = ?").bind(document).first<{ title: string | null }>();
  return {
    document,
    title: title?.title ?? null,
    sections: [...sections.entries()].sort((a, b) => a[0] - b[0]).map(([section, minutes]) => ({ section, minutes })),
  };
}

const OPEN_WINDOW = 30 * 60; // a device that synced in the last 30 minutes counts as "open"

interface DevEvent {
  document: string;
  ts: number;
  percentage: number | null;
  section: number | null;
  device: string | null;
  device_id: string | null;
}

/**
 * Where someone is, across all their devices.
 * The headline is the device with the latest page turn (pushes that didn't move the position never count as reading);
 * other devices that synced recently are listed separately, so two books open on two devices never flip-flop.
 */
export async function presenceOf(env: Env, username: string, now: number, titles: Map<string, string>, covers: Map<string, string> = new Map()) {
  const name = (doc: string) => titles.get(doc) || `Untitled book (${doc.slice(0, 6)})`;
  const lastMove = await env.DB.prepare(
    "SELECT document, ts, percentage, section, device, device_id FROM events WHERE username = ? AND moved = 1 ORDER BY ts DESC, id DESC LIMIT 1",
  ).bind(username).first<DevEvent>();
  // Latest push per device in the open window (SQLite returns the row holding MAX(ts) for the bare columns).
  const { results: devices } = await env.DB.prepare(
    "SELECT document, MAX(ts) AS ts, percentage, section, device, device_id FROM events WHERE username = ? AND ts >= ? GROUP BY device_id ORDER BY ts DESC",
  ).bind(username, now - OPEN_WINDOW).all<DevEvent>();

  const head = lastMove ?? devices[0];
  if (!head) {
    return { status: "never", last_ts: null, device: null, device_kind: "device", book: null, cover: null, pct: null, section: null, others: [] };
  }
  return {
    status: lastMove && now - lastMove.ts <= READING_WINDOW ? "reading" : "away",
    last_ts: head.ts,
    device: head.device,
    device_kind: deviceKind(head.device),
    book: name(head.document),
    cover: covers.get(head.document) ?? null,
    pct: head.percentage,
    section: head.section,
    others: devices
      .filter((d) => d.device_id !== head.device_id)
      .map((d) => ({ device: d.device, device_kind: deviceKind(d.device), book: name(d.document), pct: d.percentage, ts: d.ts })),
  };
}

/** Cheap presence snapshot for the 5-second live poll. */
export async function live(env: Env, now: number) {
  const titles = await titleMap(env);
  const covers = await coverMap(env);
  const out = await Promise.all(people(env).map(async (p) => ({ username: p.username, ...(await presenceOf(env, p.username, now, titles, covers)) })));
  return { now, people: out };
}

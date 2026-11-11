import { PAGE_CREDIT, partnersOf, people, person, tzOf, getFlag, setFlag, bookTitle } from "./config";
import { logActivity, push } from "./notify";
import { offsetSec } from "./stats";

const DAY = 86400;
const PAUSED_AFTER = 21 * DAY;
export const FINISHED_PCT = 0.995;

export type Status = "reading" | "finished" | "paused" | "abandoned";

interface Row {
  username: string;
  document: string;
  percentage: number | null;
  last_ts: number;
  title: string | null;
  authors: string | null;
  cover_url: string | null;
  started_ts: number | null;
  secs: number;
  sessions: number;
  auto_finished_ts: number | null;
  status: string | null;
  finished_at: number | null;
  rating: number | null;
  review: string | null;
  review_at: number | null;
}

/**
 * One person's status for one book. Shared by Shelves and the Now tab so they always agree.
 * Finished = marked finished by hand, or the position ever reached FINISHED_PCT (unless set back to "reading").
 */
export function statusOf(
  r: { status: string | null; finished_at: number | null; auto_finished_ts: number | null; last_ts: number },
  now: number,
): { status: Status; finishedTs: number | null } {
  const finishedTs = r.status === "reading" ? null : r.finished_at ?? r.auto_finished_ts;
  const status: Status =
    r.status === "abandoned" ? "abandoned"
    : r.status !== "reading" && finishedTs ? "finished"
    : now - r.last_ts > PAUSED_AFTER ? "paused"
    : "reading";
  return { status, finishedTs };
}

function yearStart(tz: string, now: number): { year: number; start: number } {
  const year = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(new Date(now * 1000)));
  const guess = Date.UTC(year, 0, 1) / 1000;
  return { year, start: guess - offsetSec(tz, guess) };
}

export async function library(env: Env, me: string, now: number) {
  const everyone = people(env);
  const { results } = await env.DB.prepare(`
    SELECT p.username, p.document, p.percentage, p.timestamp AS last_ts, b.title, b.authors, b.cover_url,
      (SELECT MIN(s.start_ts) FROM sessions s WHERE s.username = p.username AND s.document = p.document) AS started_ts,
      (SELECT COALESCE(SUM(s.end_ts - s.start_ts + ${PAGE_CREDIT}), 0) FROM sessions s WHERE s.username = p.username AND s.document = p.document) AS secs,
      (SELECT COUNT(*) FROM sessions s WHERE s.username = p.username AND s.document = p.document) AS sessions,
      (SELECT MIN(e.ts) FROM events e WHERE e.document = p.document AND e.username = p.username AND e.percentage >= ${FINISHED_PCT}) AS auto_finished_ts,
      ub.status, ub.finished_at, ub.rating, ub.review, ub.review_at
    FROM progress p
    LEFT JOIN books b ON b.document = p.document
    LEFT JOIN user_books ub ON ub.username = p.username AND ub.document = p.document
    ORDER BY p.timestamp DESC`).all<Row>();

  const entries = results
    .filter((r) => everyone.some((p) => p.username === r.username))
    .map((r) => {
      const { status, finishedTs } = statusOf(r, now);
      return {
        username: r.username,
        document: r.document,
        title: r.title || null,
        authors: r.authors,
        cover: r.cover_url,
        status,
        status_manual: r.status !== null,
        pct: r.percentage ?? 0,
        started_ts: r.started_ts,
        last_ts: r.last_ts,
        finished_ts: status === "finished" ? finishedTs : null,
        days_to_finish: status === "finished" && finishedTs && r.started_ts ? Math.max(1, Math.ceil((finishedTs - r.started_ts) / DAY)) : null,
        minutes: Math.round(r.secs / 60),
        sessions: r.sessions,
        rating: r.rating,
        review: r.review,
        review_at: r.review_at,
        review_hidden: false,
      };
    });

  // Spoiler-safe notes: hide someone else's note on a book you're reading but haven't finished.
  const mine = new Map(entries.filter((e) => e.username === me).map((e) => [e.document, e]));
  for (const e of entries) {
    const myCopy = mine.get(e.document);
    if (e.username !== me && e.review && myCopy && myCopy.status !== "finished") e.review_hidden = true;
  }

  const { results: wish } = await env.DB.prepare("SELECT id, username, title, authors, note, cover_url AS cover, created_at FROM wishlist ORDER BY created_at DESC").all<{
    id: number; username: string; title: string; authors: string | null; note: string | null; cover: string | null; created_at: number;
  }>();

  const peopleOut = await Promise.all(everyone.map(async (p) => {
    const { year, start } = yearStart(tzOf(env, p), now);
    const own = entries.filter((e) => e.username === p.username);
    const minutes = await env.DB.prepare(
      `SELECT COALESCE(SUM(end_ts - start_ts + ${PAGE_CREDIT}), 0) AS s FROM sessions WHERE username = ? AND start_ts >= ?`,
    ).bind(p.username, start).first<{ s: number }>();
    return {
      username: p.username,
      name: p.name,
      is_me: p.username === me,
      year: {
        year,
        finished: own.filter((e) => e.status === "finished" && (e.finished_ts ?? 0) >= start).length,
        started: own.filter((e) => (e.started_ts ?? 0) >= start).length,
        hours: Math.round(((minutes?.s ?? 0) / 3600) * 10) / 10,
      },
    };
  }));

  return { me, now, people: peopleOut, entries, wishlist: wish };
}

const clean = (v: unknown, max: number): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim().slice(0, max);
  return t || null;
};

/** Update your own record for a book: rating (0 clears), note ('' clears), status ('auto' clears an override). */
export async function updateEntry(env: Env, me: string, document: string, body: Record<string, unknown>, now: number, origin: string) {
  const has = await env.DB.prepare("SELECT 1 FROM progress WHERE username = ? AND document = ?").bind(me, document).first();
  if (!has) return { status: 404, body: { error: "You haven't read this book yet" } };

  const before = await env.DB.prepare("SELECT status, finished_at, rating, review, review_at FROM user_books WHERE username = ? AND document = ?")
    .bind(me, document)
    .first<{ status: string | null; finished_at: number | null; rating: number | null; review: string | null; review_at: number | null }>();
  let status = before?.status ?? null;
  let finishedAt = before?.finished_at ?? null;
  let rating = before?.rating ?? null;
  let review = before?.review ?? null;

  if (body.rating !== undefined) {
    const r = Number(body.rating);
    if (!Number.isInteger(r) || r < 0 || r > 5) return { status: 400, body: { error: "Rating must be 0–5" } };
    rating = r === 0 ? null : r;
  }
  const rv = clean(body.review, 1000);
  if (rv !== undefined) review = rv;
  if (body.status !== undefined) {
    if (!["finished", "abandoned", "reading", "auto"].includes(String(body.status))) return { status: 400, body: { error: "Unknown status" } };
    status = body.status === "auto" ? null : String(body.status);
    finishedAt = status === "finished" ? finishedAt ?? now : status === null ? null : finishedAt;
  }

  await env.DB.prepare(
    `INSERT INTO user_books (username, document, status, finished_at, rating, review, review_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(username, document) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at, rating = excluded.rating,
       review = excluded.review, review_at = excluded.review_at, updated_at = excluded.updated_at`,
  ).bind(me, document, status, finishedAt, rating, review, review !== (before?.review ?? null) ? (review ? now : null) : before?.review_at ?? null, now).run();

  const who = person(env, me);
  const name = who?.name ?? me;
  const title = await bookTitle(env, document);
  const partners = partnersOf(env, me);

  if (rating && rating !== before?.rating) {
    const stars = "★".repeat(rating) + "☆".repeat(5 - rating);
    const text = `${name} rated ${title} ${stars}`;
    await logActivity(env, { ts: now, kind: "rated", actor: me, document, text });
    await push(env, partners, { title: `⭐ ${text}`, message: review ? "They wrote a note too. Open Shelves to read it." : "Open Shelves to see it.", tags: ["star"] }, origin);
  } else if (review && review !== before?.review) {
    await logActivity(env, { ts: now, kind: "note", actor: me, document, text: `${name} wrote a note on ${title}` });
  }
  if (status === "finished" && before?.status !== "finished") {
    const key = `finished:${me}:${document}`;
    if (!(await getFlag(env, key))) {
      await setFlag(env, key, "1", now);
      const text = `${name} finished ${title}!`;
      await logActivity(env, { ts: now, kind: "finished", actor: me, document, text });
      await push(env, partners, { title: `🎉 ${text}`, message: "Time to talk about the ending.", tags: ["tada"], priority: 4 }, origin);
    }
  }
  if (status === "abandoned" && before?.status !== "abandoned") {
    await logActivity(env, { ts: now, kind: "abandoned", actor: me, document, text: `${name} put ${title} down` });
  }
  return { status: 200, body: { ok: true } };
}

export async function addWish(env: Env, me: string, body: Record<string, unknown>, now: number, origin: string) {
  const title = clean(body.title, 200);
  if (!title) return { status: 400, body: { error: "Give the book a title." } };
  const authors = clean(body.authors, 300) ?? null;
  const note = clean(body.note, 500) ?? null;
  const row = await env.DB.prepare("INSERT INTO wishlist (username, title, authors, note, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id")
    .bind(me, title, authors, note, now)
    .first<{ id: number }>();
  const name = person(env, me)?.name ?? me;
  const text = `${name} wants to read ${title}${authors ? ` by ${authors}` : ""}`;
  await logActivity(env, { ts: now, kind: "wish", actor: me, text });
  await push(env, partnersOf(env, me), { title: `📌 ${text}`, message: note ?? "Added to their want-to-read shelf.", tags: ["pushpin"], priority: 2 }, origin);
  return { status: 201, body: { ok: true, id: row?.id } };
}

export async function removeWish(env: Env, me: string, id: number) {
  const r = await env.DB.prepare("DELETE FROM wishlist WHERE id = ? AND username = ?").bind(id, me).run();
  return r.meta.changes ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "Not on your shelf" } };
}

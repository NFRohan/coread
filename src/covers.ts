/**
 * Book covers from Open Library (free, no key). We only keep a result whose title matches,
 * so study guides and box sets with similar names are skipped.
 * Set COVER_LOOKUP=off (local tests) to skip network lookups.
 */

const SEARCH = "https://openlibrary.org/search.json";
const COVER = (id: number) => `https://covers.openlibrary.org/b/id/${id}-M.jpg`;
const UA = "coread/1.0 (private two-person reading companion)";

const norm = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Strip subtitles and series noise: "Everything Is Tuberculosis: The History…" → "everything is tuberculosis". */
const mainTitle = (s: string) => norm(s.split(/[:(\[|]/)[0]);

interface Doc {
  title?: string;
  author_name?: string[];
  cover_i?: number;
}

export async function findCover(env: Env, title: string, authors?: string | null): Promise<string | null> {
  if (env.COVER_LOOKUP === "off") return null;
  const want = mainTitle(title);
  if (!want) return null;
  const firstAuthor = (authors || "").split("\n")[0].trim();
  const surname = firstAuthor.split(/\s+/).pop() || "";

  const tries: Record<string, string>[] = [];
  if (surname) tries.push({ title: title.split(/[:(\[|]/)[0].trim(), author: surname });
  tries.push({ q: title });

  for (const params of tries) {
    const url = new URL(SEARCH);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("fields", "title,author_name,cover_i");
    url.searchParams.set("limit", "10");
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const data = (await res.json()) as { docs?: Doc[] };
      const docs = (data.docs ?? []).filter((d) => d.cover_i && d.title);
      const exact = docs.find((d) => mainTitle(d.title as string) === want);
      const loose = docs.find((d) => {
        const t = mainTitle(d.title as string);
        return t.length >= 4 && (t.startsWith(want) || want.startsWith(t)) &&
          (!surname || (d.author_name ?? []).some((a) => norm(a).includes(norm(surname))));
      });
      const pick = exact ?? loose;
      if (pick?.cover_i) return COVER(pick.cover_i);
    } catch (e) {
      console.error(JSON.stringify({ msg: "cover lookup failed", title, error: String(e) }));
    }
  }
  return null;
}

/** Look up covers for titled books that haven't been checked for their current title (a few per call). */
export async function backfillCovers(env: Env, now: number, limit = 4): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT document, title, authors FROM books
     WHERE title IS NOT NULL AND COALESCE(cover_source, '') <> 'manual'
       AND (cover_checked_at IS NULL OR cover_query IS NOT title)
     LIMIT ?`,
  ).bind(limit).all<{ document: string; title: string; authors: string | null }>();
  for (const b of results) {
    const url = await findCover(env, b.title, b.authors);
    if (env.COVER_LOOKUP === "off") return;
    await env.DB.prepare("UPDATE books SET cover_url = ?, cover_source = ?, cover_query = ?, cover_checked_at = ? WHERE document = ?")
      .bind(url, url ? "openlibrary" : "none", b.title, now, b.document)
      .run();
  }
}

export async function coverForWish(env: Env, id: number, title: string, authors: string | null): Promise<void> {
  const url = await findCover(env, title, authors);
  if (url) await env.DB.prepare("UPDATE wishlist SET cover_url = ? WHERE id = ?").bind(url, id).run();
}

/** Set a cover by hand (https image URL), or pass null to go back to automatic lookup. */
export async function setCover(env: Env, document: string, url: string | null, now: number): Promise<void> {
  if (url) {
    await env.DB.prepare(
      `INSERT INTO books (document, title, updated_at, cover_url, cover_source, cover_checked_at) VALUES (?, NULL, ?, ?, 'manual', ?)
       ON CONFLICT(document) DO UPDATE SET cover_url = excluded.cover_url, cover_source = 'manual', cover_checked_at = excluded.cover_checked_at`,
    ).bind(document, now, url, now).run();
  } else {
    await env.DB.prepare("UPDATE books SET cover_url = NULL, cover_source = NULL, cover_query = NULL, cover_checked_at = NULL WHERE document = ?")
      .bind(document)
      .run();
  }
}

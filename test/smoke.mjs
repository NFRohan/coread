// End-to-end smoke test against `npm run dev:test` (wrangler dev with local D1, PUSH_DRY_RUN, clock override).
// Talks to the server exactly the way Readest's KOSyncClient does.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const BASE = process.env.BASE || "http://127.0.0.1:8787";
const md5 = (s) => createHash("md5").update(s).digest("hex");
const KO = { accept: "application/vnd.koreader.v1+json" };
const auth = (u, pw) => ({ ...KO, "x-auth-user": u, "x-auth-key": md5(pw) });
let failures = 0;

async function call(path, { method = "GET", headers = {}, body, now } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (now) h["x-coread-now"] = String(now);
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

const A = "rohan", APW = "rohan-pass";
const B = "her", BPW = "her-pass";
const DOC = "0123456789abcdef0123456789abcdef";
const meta = { filename: "The_Book.epub", title: "The Book", authors: "An Author" };
const t0 = Math.floor(Date.now() / 1000) - 3 * 3600;

console.log(`smoke test against ${BASE}`);

await check("healthcheck", async () => {
  const r = await call("/healthcheck");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { state: "OK" });
});

await check("unknown user is unauthorized, then registers (Readest connect flow)", async () => {
  const r1 = await call("/users/auth", { headers: auth(A, APW) });
  assert.equal(r1.status, 401);
  const r2 = await call("/users/create", { method: "POST", headers: KO, body: { username: A, password: md5(APW) } });
  assert.equal(r2.status, 201, JSON.stringify(r2.data));
  const r3 = await call("/users/auth", { headers: auth(A, APW) });
  assert.equal(r3.status, 200);
  assert.deepEqual(r3.data, { authorized: "OK" });
  const r4 = await call("/users/create", { method: "POST", headers: KO, body: { username: B, password: md5(BPW) } });
  assert.equal(r4.status, 201);
});

await check("registration is closed to usernames not in USERS", async () => {
  const r = await call("/users/create", { method: "POST", headers: KO, body: { username: "stranger", password: md5("x") } });
  assert.equal(r.status, 403);
  assert.ok(r.data.message);
});

await check("re-registering an existing user returns 402 (Readest: 'Invalid credentials')", async () => {
  const r = await call("/users/create", { method: "POST", headers: KO, body: { username: A, password: md5("other") } });
  assert.equal(r.status, 402);
});

await check("wrong key is rejected; HTTP Basic fallback works", async () => {
  assert.equal((await call("/users/auth", { headers: auth(A, "nope") })).status, 401);
  const basic = { ...KO, authorization: "Basic " + Buffer.from(`${A}:${APW}`).toString("base64") };
  assert.equal((await call("/users/auth", { headers: basic })).status, 200);
});

// Rohan reads 30 minutes: pushes every 2 minutes, crossing from section 3 to 4.
await check("progress pushes are accepted and read back", async () => {
  for (let i = 0; i <= 15; i++) {
    const section = i < 8 ? 3 : 4;
    const r = await call("/syncs/progress", {
      method: "PUT", headers: auth(A, APW), now: t0 + i * 120,
      body: { document: DOC, progress: `/body/DocFragment[${section}]/body/p[${i + 1}]/text().0`, percentage: 0.1 + i * 0.002,
              device: "Phone", device_id: "dev-rohan-phone", metadata: meta },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.document, DOC);
  }
  const g = await call(`/syncs/progress/${DOC}`, { headers: auth(A, APW) });
  assert.equal(g.status, 200);
  assert.equal(g.data.device, "Phone");
  assert.ok(Math.abs(g.data.percentage - 0.13) < 1e-9, `percentage ${g.data.percentage}`);
  assert.match(g.data.progress, /DocFragment\[4\]/);
  const none = await call("/syncs/progress/ffffffffffffffffffffffffffffffff", { headers: auth(A, APW) });
  assert.deepEqual(none.data, {});
});

// She reads at the same time, further ahead (spoiler zone), on her tablet.
await check("partner pushes overlap in time and are further ahead", async () => {
  for (let i = 0; i <= 10; i++) {
    const r = await call("/syncs/progress", {
      method: "PUT", headers: auth(B, BPW), now: t0 + 600 + i * 120,
      body: { document: DOC, progress: `/body/DocFragment[6]/body/p[${i + 1}]/text().0`, percentage: 0.3 + i * 0.003,
              device: "Tablet", device_id: "dev-her-tab" },
    });
    assert.equal(r.status, 200);
  }
});

let cookie = "";
await check("companion page: login sets a session cookie; bad password rejected", async () => {
  const bad = await call("/api/login", { method: "POST", body: { username: A, password: "nope" } });
  assert.equal(bad.status, 401);
  const r = await call("/api/login", { method: "POST", body: { username: A, password: APW } });
  assert.equal(r.status, 200);
  const sc = r.headers.get("set-cookie");
  assert.match(sc, /coread_session=.*HttpOnly/);
  cookie = sc.split(";")[0];
});

await check("state requires sign-in", async () => {
  assert.equal((await call("/api/state")).status, 401);
});

await check("state: presence, shared book with spoiler gap, stats, together time, activity", async () => {
  const now = t0 + 600 + 10 * 120 + 60; // a minute after her last push
  const r = await call("/api/state", { headers: { cookie }, now });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const s = r.data;
  const me = s.people.find((p) => p.username === A);
  const her = s.people.find((p) => p.username === B);
  assert.equal(her.presence.status, "reading");
  assert.equal(her.presence.device_kind, "tablet");
  assert.equal(me.presence.status, "reading"); // his last push was a minute ago too
  assert.equal(s.together.now, true);
  const book = s.books.find((b) => b.document === DOC);
  assert.equal(book.title, "The Book");
  assert.equal(book.shared, true);
  assert.ok(book.gap < -0.05 && book.spoiler, `gap ${book.gap}`);
  const sum = (p) => p.stats.last14.reduce((a, d) => a + d.min, 0);
  assert.equal(sum(me), 31, `rohan minutes ${sum(me)}`); // 30 min of pushes + 1 min credit
  assert.equal(sum(her), 21, `her minutes ${sum(her)}`);
  assert.ok(s.together.month_min >= 20 && s.together.month_min <= 22, `together ${s.together.month_min}`);
  assert.equal(me.stats.heat.flat().reduce((a, b) => a + b, 0), 31);
  const kinds = s.activity.map((a) => a.kind);
  for (const k of ["newbook", "section", "together", "spoiler"]) assert.ok(kinds.includes(k), `activity missing ${k}: ${kinds}`);
  assert.equal(kinds.filter((k) => k === "section").length, 1);
  assert.equal(kinds.filter((k) => k === "together").length, 1, "together notification should fire once (cooldown)");
});

await check("nudge works once, then cools down", async () => {
  const r1 = await call("/api/nudge", { method: "POST", headers: { cookie }, body: {} });
  assert.equal(r1.status, 200);
  const r2 = await call("/api/nudge", { method: "POST", headers: { cookie }, body: {} });
  assert.equal(r2.status, 429);
  assert.ok(r2.data.wait_s > 0);
});

const herLast = t0 + 600 + 10 * 120;

await check("granular: time per page in state and session list", async () => {
  const s = (await call("/api/state", { headers: { cookie }, now: herLast + 60 })).data;
  const me = s.people.find((p) => p.username === A);
  assert.equal(me.pages_7d.sec_per_page, 120);
  assert.equal(me.pages_7d.count, 15);
  const mine = s.sessions.find((x) => x.username === A && x.document === DOC);
  assert.equal(mine.minutes, 31);
  assert.equal(mine.pages, 15);
  assert.equal(mine.sec_per_page, 120);
  assert.equal(mine.jumps, 0);
  assert.equal(mine.title, "The Book");
});

await check("granular: per-section minutes for both readers", async () => {
  const r = await call(`/api/book/${DOC}/sections`, { headers: { cookie } });
  assert.equal(r.status, 200);
  const sec = Object.fromEntries(r.data.sections.map((x) => [x.section, x.minutes]));
  assert.deepEqual(sec[3], { [A]: 16 });          // 8 gaps of 2 min
  assert.deepEqual(sec[4], { [A]: 15 });          // 7 gaps of 2 min + 1 min for the last page
  assert.deepEqual(sec[6], { [B]: 21 });
});

await check("granular: live presence snapshot", async () => {
  const r = await call("/api/live", { headers: { cookie }, now: herLast + 30 });
  assert.equal(r.status, 200);
  const her = r.data.people.find((p) => p.username === B);
  assert.equal(her.status, "reading");
  assert.equal(her.section, 6);
  assert.equal(her.device_kind, "tablet");
  assert.ok(Math.abs(her.pct - 0.33) < 1e-9);
  const later = await call("/api/live", { headers: { cookie }, now: herLast + 3600 });
  assert.equal(later.data.people.find((p) => p.username === B).status, "away");
});

await check("granular: a jump back shows up in the session timeline", async () => {
  const r = await call("/syncs/progress", {
    method: "PUT", headers: auth(A, APW), now: t0 + 15 * 120 + 90,
    body: { document: DOC, progress: "/body/DocFragment[2]/body/p[1]/text().0", percentage: 0.05, device: "Phone", device_id: "dev-rohan-phone" },
  });
  assert.equal(r.status, 200);
  const s = (await call("/api/state", { headers: { cookie }, now: herLast + 60 })).data;
  const mine = s.sessions.find((x) => x.username === A && x.document === DOC);
  const d = await call(`/api/session/${mine.id}`, { headers: { cookie } });
  assert.equal(d.status, 200);
  assert.equal(d.data.jumps, 1);
  assert.equal(d.data.points.length, 17);
  assert.equal(d.data.points.at(-1).kind, "back");
  assert.equal(d.data.points[1].kind, "page");
  assert.equal(d.data.points[1].page_s, 120);
  assert.equal((await call("/api/session/999999", { headers: { cookie } })).status, 404);
});

await check("untitled books can be named from the page", async () => {
  const DOC2 = "fedcba9876543210fedcba9876543210";
  const r = await call("/syncs/progress", {
    method: "PUT", headers: auth(B, BPW), now: herLast + 120,
    body: { document: DOC2, progress: "/body/DocFragment[2]/body/p[1]/text().0", percentage: 0.01, device: "Readest (Windows)", device_id: "dev-her-pc" },
  });
  assert.equal(r.status, 200);
  let s = (await call("/api/state", { headers: { cookie }, now: herLast + 130 })).data;
  let b = s.books.find((x) => x.document === DOC2);
  assert.equal(b.named, false);
  assert.match(b.title, /^Untitled book/);
  const n = await call(`/api/book/${DOC2}/title`, { method: "POST", headers: { cookie }, body: { title: "  Second Book  " } });
  assert.equal(n.status, 200, JSON.stringify(n.data));
  s = (await call("/api/state", { headers: { cookie }, now: herLast + 140 })).data;
  b = s.books.find((x) => x.document === DOC2);
  assert.equal(b.named, true);
  assert.equal(b.title, "Second Book");
  assert.equal((await call(`/api/book/${DOC2}/title`, { method: "POST", headers: { cookie }, body: { title: "" } })).status, 400);
  assert.equal((await call("/api/book/nope/title", { method: "POST", headers: { cookie }, body: { title: "X" } })).status, 404);
  assert.equal((await call(`/api/book/${DOC2}/title`, { method: "POST", body: { title: "X" } })).status, 401);
});

let herCookie = "";
await check("shelves: entries for both people, including different books", async () => {
  const r = await call("/api/login", { method: "POST", body: { username: B, password: BPW } });
  herCookie = r.headers.get("set-cookie").split(";")[0];
  const lib = (await call("/api/library", { headers: { cookie }, now: herLast + 200 })).data;
  const mine = lib.entries.filter((e) => e.username === A);
  const hers = lib.entries.filter((e) => e.username === B);
  assert.equal(mine.length, 1);
  assert.equal(hers.length, 2);
  assert.equal(mine[0].status, "reading");
  assert.equal(mine[0].title, "The Book");
  assert.equal(mine[0].sessions, 1);
  assert.ok(mine[0].minutes >= 31);
  assert.ok(hers.some((e) => e.title === "Second Book"));
  assert.equal(lib.people.find((p) => p.username === B).year.started, 2);
});

await check("shelves: rating + note, hidden from a partner still reading the same book", async () => {
  const r = await call(`/api/library/${DOC}`, { method: "POST", headers: { cookie }, body: { rating: 4, review: "Loved the ending!" }, now: herLast + 210 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await call(`/api/library/${DOC}`, { method: "POST", headers: { cookie }, body: { rating: 7 } })).status, 400);
  assert.equal((await call("/api/library/nope", { method: "POST", headers: { cookie }, body: { rating: 3 } })).status, 404);
  const asMe = (await call("/api/library", { headers: { cookie }, now: herLast + 220 })).data;
  const mineSeen = asMe.entries.find((e) => e.username === A && e.document === DOC);
  assert.equal(mineSeen.rating, 4);
  assert.equal(mineSeen.review, "Loved the ending!");
  assert.equal(mineSeen.review_hidden, false);
  const asHer = (await call("/api/library", { headers: { cookie: herCookie }, now: herLast + 220 })).data;
  assert.equal(asHer.entries.find((e) => e.username === A && e.document === DOC).review_hidden, true);
});

await check("shelves: mark finished by hand, then undo", async () => {
  await call(`/api/library/${DOC}`, { method: "POST", headers: { cookie }, body: { status: "finished" }, now: herLast + 230 });
  let lib = (await call("/api/library", { headers: { cookie }, now: herLast + 240 })).data;
  let e = lib.entries.find((x) => x.username === A && x.document === DOC);
  assert.equal(e.status, "finished");
  assert.ok(e.finished_ts && e.days_to_finish >= 1);
  assert.equal(lib.people.find((p) => p.username === A).year.finished, 1);
  const asHer = (await call("/api/library", { headers: { cookie: herCookie }, now: herLast + 240 })).data;
  assert.equal(asHer.entries.find((x) => x.username === A && x.document === DOC).review_hidden, true, "still hidden: she hasn't finished");
  // Now tab: the shared book stays while she's still reading, with his row marked finished...
  let st = (await call("/api/state", { headers: { cookie }, now: herLast + 240 })).data;
  let book = st.books.find((b) => b.document === DOC);
  assert.ok(book, "shared book stays on Now while the partner is still reading");
  assert.equal(book.readers.find((r) => r.username === A).done, "finished");
  assert.equal(book.readers.find((r) => r.username === B).done, null);
  // ...and leaves Now once both are done (put down counts too), without flipping the page back to first run.
  await call(`/api/library/${DOC}`, { method: "POST", headers: { cookie: herCookie }, body: { status: "abandoned" }, now: herLast + 242 });
  st = (await call("/api/state", { headers: { cookie }, now: herLast + 244 })).data;
  assert.equal(st.books.find((b) => b.document === DOC), undefined, "finished-by-everyone book leaves Now");
  assert.equal(st.has_history, true);
  await call(`/api/library/${DOC}`, { method: "POST", headers: { cookie: herCookie }, body: { status: "auto" }, now: herLast + 246 });

  await call(`/api/library/${DOC}`, { method: "POST", headers: { cookie }, body: { status: "auto" }, now: herLast + 250 });
  lib = (await call("/api/library", { headers: { cookie }, now: herLast + 260 })).data;
  e = lib.entries.find((x) => x.username === A && x.document === DOC);
  assert.equal(e.status, "reading");
  assert.equal(e.rating, 4, "rating survives a status change");
});

await check("shelves: want-to-read list, only the owner can remove", async () => {
  const add = await call("/api/wishlist", { method: "POST", headers: { cookie }, body: { title: "Pather Panchali", authors: "Bibhutibhushan Bandyopadhyay", note: "For the monsoon" } });
  assert.equal(add.status, 201);
  assert.equal((await call("/api/wishlist", { method: "POST", headers: { cookie }, body: { title: "  " } })).status, 400);
  const lib = (await call("/api/library", { headers: { cookie: herCookie } })).data;
  const w = lib.wishlist.find((x) => x.title === "Pather Panchali");
  assert.equal(w.username, A);
  assert.equal((await call(`/api/wishlist/${w.id}`, { method: "DELETE", headers: { cookie: herCookie } })).status, 404);
  assert.equal((await call(`/api/wishlist/${w.id}`, { method: "DELETE", headers: { cookie } })).status, 200);
  const kinds = (await call("/api/state", { headers: { cookie } })).data.activity.map((a) => a.kind);
  for (const k of ["rated", "finished", "wish", "newbook"]) assert.ok(kinds.includes(k), `activity missing ${k}`);
});

await check("two devices, two books: no flip-flopping, no split sessions, no double-counted minutes", async () => {
  const T = t0 + 7200;
  const DOC3 = "11112222333344445555666677778888";
  const minutes = async (now) => (await call("/api/state", { headers: { cookie }, now })).data.people.find((p) => p.username === A).stats.last14.reduce((a, d) => a + d.min, 0);
  const before = await minutes(T - 10);

  const pushes = [];
  for (let i = 0; i <= 10; i++) {   // phone: actually reading The Book, a page a minute
    pushes.push([T + i * 60, { document: DOC, progress: `/body/DocFragment[5]/body/p[${i + 1}]/text().0`, percentage: 0.06 + i * 0.001, device: "Phone", device_id: "dev-rohan-phone" }]);
  }
  // laptop: opens a different book once, then only re-syncs the same position (focus/blur)
  pushes.push([T + 30, { document: DOC3, progress: "/body/DocFragment[1]/body/p[1]/text().0", percentage: 0.2, device: "Laptop", device_id: "dev-rohan-pc", metadata: { title: "Third Book", authors: "Someone", filename: "third.epub" } }]);
  for (let k = 1; k <= 4; k++) {
    pushes.push([T + 30 + k * 60, { document: DOC3, progress: "/body/DocFragment[1]/body/p[1]/text().0", percentage: 0.2, device: "Laptop", device_id: "dev-rohan-pc" }]);
  }
  pushes.sort((a, b) => a[0] - b[0]);
  for (const [ts, body] of pushes) {
    const r = await call("/syncs/progress", { method: "PUT", headers: auth(A, APW), now: ts, body });
    assert.equal(r.status, 200);
  }

  const now = T + 620;
  const s = (await call("/api/state", { headers: { cookie }, now })).data;
  const me = s.people.find((p) => p.username === A);
  assert.equal(me.presence.status, "reading");
  assert.equal(me.presence.device_kind, "phone");
  assert.equal(me.presence.book, "The Book", "headline follows the device that's turning pages");
  assert.ok(me.presence.others.some((o) => o.book === "Third Book" && o.device_kind === "computer"), "laptop listed as also open");
  const live = (await call("/api/live", { headers: { cookie }, now })).data.people.find((p) => p.username === A);
  assert.equal(live.book, "The Book");

  const phone = s.sessions.find((x) => x.username === A && x.document === DOC && x.start_ts === T);
  assert.equal(phone.pushes, 11, "phone session not split by the laptop");
  const third = s.sessions.filter((x) => x.username === A && x.document === DOC3);
  assert.equal(third.length, 1, "idle re-syncs start no sessions");
  assert.equal(third[0].pushes, 1);

  assert.equal((await minutes(now)) - before, 11, "parallel devices count once (11 min, not 12)");

  const reading = ["started", "newbook", "section", "together", "finished"];
  const kinds = s.activity.filter((a) => a.ts >= T && a.actor === A && reading.includes(a.kind)).map((a) => a.kind).sort();
  assert.deepEqual(kinds, ["newbook", "started"], `activity since T: ${kinds}`);
});

await check("covers: set by hand, rejected if not https, reset to automatic", async () => {
  const url = "https://covers.openlibrary.org/b/id/8818261-M.jpg";
  assert.equal((await call(`/api/book/${DOC}/cover`, { method: "POST", headers: { cookie }, body: { url: "http://example.com/x.jpg" } })).status, 400);
  assert.equal((await call("/api/book/nope/cover", { method: "POST", headers: { cookie }, body: { url } })).status, 404);
  assert.equal((await call(`/api/book/${DOC}/cover`, { method: "POST", headers: { cookie }, body: { url } })).status, 200);
  let s = (await call("/api/state", { headers: { cookie } })).data;
  assert.equal(s.books.find((b) => b.document === DOC).cover, url);
  const lib = (await call("/api/library", { headers: { cookie } })).data;
  assert.equal(lib.entries.find((e) => e.username === A && e.document === DOC).cover, url);
  assert.equal((await call(`/api/book/${DOC}/cover`, { method: "POST", headers: { cookie }, body: { url: "" } })).status, 200);
  s = (await call("/api/state", { headers: { cookie } })).data;
  assert.equal(s.books.find((b) => b.document === DOC).cover, null);
});

await check("settings: push key, server URL, partners", async () => {
  const r = await call("/api/settings", { headers: { cookie } });
  assert.equal(r.status, 200);
  assert.equal(r.data.username, A);
  assert.match(r.data.push_key ?? "", /^B[A-Za-z0-9_-]{86}$/, "VAPID public key should be a raw P-256 point (set it in .dev.vars)");
  assert.equal(r.data.server_url, BASE);
  assert.deepEqual(r.data.partners, ["Her name"]);
  assert.equal((await call("/api/settings")).status, 401);
});

await check("web push: subscribe a device, test notification (encrypted, dry run), cooldown, unsubscribe", async () => {
  const t = Math.floor(Date.now() / 1000) + 3600;
  // No device yet: the test fails with a clear reason.
  const none = await call("/api/test-notify", { method: "POST", headers: { cookie }, body: {}, now: t });
  assert.equal(none.status, 502);
  assert.match(none.data.error, /aren't turned on/);

  // A real browser-style key pair, so the server's encryption actually runs.
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const p256dh = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url");
  const sub = { endpoint: "https://push.example/sub/rohan-phone", keys: { p256dh, auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url") } };
  assert.equal((await call("/api/push/subscribe", { method: "POST", headers: { cookie }, body: { ...sub, endpoint: "http://insecure.example/x" } })).status, 400);
  assert.equal((await call("/api/push/subscribe", { method: "POST", headers: { cookie }, body: { ...sub, label: "Android · Chrome" } })).status, 200);
  const s = (await call("/api/settings", { headers: { cookie } })).data;
  assert.deepEqual(s.push_devices.map((d) => d.label), ["Android · Chrome"]);

  const ok = await call("/api/test-notify", { method: "POST", headers: { cookie }, body: {}, now: t + 31 });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.devices, 1);
  assert.equal((await call("/api/test-notify", { method: "POST", headers: { cookie }, body: {}, now: t + 40 })).status, 429);

  // Her account can't remove his device; he can.
  const her = (await call("/api/login", { method: "POST", body: { username: B, password: BPW } })).headers.get("set-cookie").split(";")[0];
  await call("/api/push/unsubscribe", { method: "POST", headers: { cookie: her }, body: { endpoint: sub.endpoint } });
  assert.equal((await call("/api/settings", { headers: { cookie } })).data.push_devices.length, 1);
  await call("/api/push/unsubscribe", { method: "POST", headers: { cookie }, body: { endpoint: sub.endpoint } });
  assert.equal((await call("/api/settings", { headers: { cookie } })).data.push_devices.length, 0);
});

await check("cross-origin POST to the page API is refused", async () => {
  const r = await fetch(BASE + "/api/nudge", { method: "POST", headers: { cookie, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 403);
});

await check("weekly recap (cron) runs and lands in the activity feed", async () => {
  const r = await fetch(BASE + "/__scheduled?cron=0+15+*+*+SUN");
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 500));
  const s = await call("/api/state", { headers: { cookie } });
  assert.ok(s.data.activity.some((a) => a.kind === "recap"), "no recap in activity");
});

await check("static page is served", async () => {
  const r = await fetch(BASE + "/");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<title>coread<\/title>/);
});

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);

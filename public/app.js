"use strict";
// coread companion page — warm-minimal redesign (Claude Design handoff). Vanilla JS, no build step.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const NS = "http://www.w3.org/2000/svg";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DEVICE = { phone: "phone", tablet: "tablet", computer: "PC", device: "device" };
const DEVICE_ICON = { phone: "smartphone", tablet: "tablet", computer: "monitor", device: "smartphone" };
const ACTIVITY_ICON = {
  newbook: "book-plus", started: "book-open", section: "bookmark-check", finished: "book-check", together: "heart",
  spoiler: "triangle-alert", nudge: "hand-heart", rated: "star", note: "pencil-line", wish: "bookmark-plus",
  abandoned: "book-down", named: "pencil-line", recap: "calendar-days",
};
const ic = (name, cls = "") => `<i class="icon-${name}${cls ? " " + cls : ""}" aria-hidden="true"></i>`;

// ---------------- state ----------------
let state = null;          // /api/state
let lib = null;            // /api/library
const DASH_VIEWS = ["today", "habits", "sessions", "activity"]; // tabs drawn from /api/state
const VIEWS = [...DASH_VIEWS, "shelves", "settings"];
let view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "today";
let settings = null;       // /api/settings
let heatFor = null;
let shelfFor = null;
let dailyTable = false;
let timers = [];
let clockRef = { server: 0, client: 0 }; // server time at the last poll, to tick "x s ago" between polls
const openSessions = new Set();
const sessionCache = new Map();
const openBooks = new Set();
const tableBooks = new Set();
const sectionCache = new Map();
const revealed = new Set();

// ---------------- formatting ----------------
const color = (slot) => `var(--series-${(slot % 2) + 1})`;
const hm = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m` : `${min}m`);
const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;
function ago(ts, now) {
  const s = Math.max(0, now - ts);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
function agoFine(ts, now) {
  const s = Math.max(0, Math.round(now - ts));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return ago(ts, now);
}
const agoSpan = (ts, now) => `<span class="ago" data-ts="${ts}">${agoFine(ts, now)}</span>`;
const serverNow = () => clockRef.server + (Date.now() / 1000 - clockRef.client);
const fmtSec = (x) => (x == null ? "–" : x < 60 ? `${Math.round(x)} s` : `${Math.floor(x / 60)}m ${String(Math.round(x % 60)).padStart(2, "0")}s`);
const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const shortDate = (ts) => new Date(ts * 1000).toLocaleDateString([], { day: "numeric", month: "short", year: new Date(ts * 1000).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
function dayName(ts, now) {
  const d = new Date(ts * 1000), n = new Date(now * 1000);
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (d.toDateString() === n.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}
function hoursLeft(h) {
  if (h == null) return null;
  if (h < 1) return `~${Math.max(5, Math.round((h * 60) / 5) * 5)} min left`;
  return `~${h < 10 ? h.toFixed(1) : Math.round(h)} h left`;
}
const person = (u) => state?.people.find((x) => x.username === u);
const nameOf = (u) => { const p = person(u); return p ? (p.is_me ? "You" : p.name) : u; };
const slotOf = (u) => person(u)?.slot ?? 0;
const initial = (name) => esc(String(name || "?").slice(0, 1).toUpperCase());
const partner = () => state?.people.find((p) => !p.is_me);
const stars = (n) => "★".repeat(n) + "☆".repeat(5 - n);

/** A book cover, or a quiet typographic placeholder when there's none or it fails to load. */
function cover(url, title, cls = "") {
  const t = String(title || "").replace(/^untitled book.*$/i, "");
  const initials = t.replace(/^(the|a|an)\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "·";
  const ph = `<span class="cover ph ${cls}" aria-hidden="true">${esc(initials)}</span>`;
  if (!url) return ph;
  return `<img class="cover ${cls}" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-ph="${esc(ph)}" onerror="this.outerHTML=this.dataset.ph">`;
}

// ---------------- api ----------------
async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", headers: opts.body ? { "content-type": "application/json" } : {}, ...opts });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function stopTimers() { timers.forEach(clearInterval); timers = []; }

function showLogin() {
  $("shell").hidden = true;
  $("login-view").hidden = false;
  stopTimers();
}

async function refresh() {
  const r = await api("/api/state");
  if (r.status === 401) return showLogin();
  if (!r.ok) { $("updated").textContent = "Couldn't refresh. Retrying…"; return; }
  state = r.data;
  clockRef = { server: state.now, client: Date.now() / 1000 };
  $("login-view").hidden = true;
  $("shell").hidden = false;
  applyView();
  render();
  if (!refresh.synced) { refresh.synced = true; syncPush(); } // once per page load, when signed in
  if (view === "shelves") loadLibrary();
  if (view === "settings") loadSettings();
}

async function pollLive() {
  if (!state) return;
  const r = await api("/api/live");
  if (r.status === 401) return showLogin();
  if (!r.ok) return;
  clockRef = { server: r.data.now, client: Date.now() / 1000 };
  for (const lp of r.data.people) { const p = person(lp.username); if (p) p.live = lp; }
  renderPresence(state);
}

function tick() {
  const now = serverNow();
  document.querySelectorAll(".ago[data-ts]").forEach((el) => { el.textContent = agoFine(+el.dataset.ts, now); });
}

// ---------------- Today ----------------
function render() {
  const s = state;
  const empty = !s.has_history; // nobody has synced a book yet (not just "no current books")
  $("first-run").hidden = !empty;
  $("first-run-partner").textContent = partner() ? `${partner().name}'s` : "theirs";
  $("books-section").hidden = empty;
  $("habits-section").hidden = empty;
  $("habits-empty").hidden = !empty;
  $("sessions-section").hidden = empty || !s.sessions.length;
  $("sessions-empty").hidden = !$("sessions-section").hidden;
  renderPresence(s);
  if (!empty) {
    renderBooks(s);
    renderHabits(s);
    renderDaily(s);
    renderHeat(s);
    renderSessions(s);
  }
  renderActivity(s);
  $("updated").textContent = `Updated ${clock(s.now)} · live status every 5 s`;
}

function renderPresence(s) {
  const now = serverNow();
  $("presence").innerHTML = s.people.map((p) => {
    const pr = p.live || p.presence;
    const whose = p.is_me ? "your" : "their";
    const dev = DEVICE[pr.device_kind] || "device";
    const devIc = ic(DEVICE_ICON[pr.device_kind] || "smartphone");
    let status;
    if (pr.status === "reading") status = `<span class="now">Reading now</span>${devIc}<span>on ${whose} ${dev} · page turned ${agoSpan(pr.last_ts, now)}</span>`;
    else if (pr.status === "away") status = `${devIc}<span>Last read ${agoSpan(pr.last_ts, now)} on ${dev}</span>`;
    else status = `<span>Hasn't synced yet</span>`;
    const where = [pr.pct != null ? pct(pr.pct) : null, pr.section ? `section ${pr.section}` : null].filter(Boolean).join(" · ");
    const book = pr.book ? `<div class="p-book"><span class="bt">${esc(pr.book)}</span>${where ? ` · ${where}` : ""}</div>` : "";
    const extras = (pr.others || []).map((o) =>
      `<div class="p-extra">${ic(DEVICE_ICON[o.device_kind] || "smartphone")}<span>Also open on ${whose} ${DEVICE[o.device_kind] || "device"}: <em class="t">${esc(o.book)}</em> · ${agoSpan(o.ts, now)}</span></div>`).join("");
    const dot = pr.status === "reading" ? `<span class="status-dot live"></span>` : pr.status === "away" ? `<span class="status-dot away"></span>` : "";
    return `<article class="card presence">
      <div class="avatar"><span style="background:${color(p.slot)}">${initial(p.name)}</span>${dot}</div>
      <div class="p-body">
        <div class="p-name">${esc(p.name)}${p.is_me ? `<span class="you"> (you)</span>` : ""}</div>
        <div class="p-status">${status}</div>${book}${extras}
      </div></article>`;
  }).join("");

  const t = s.together;
  const bothNow = s.people.length > 1 && s.people.every((p) => (p.live || p.presence).status === "reading");
  let banner = "";
  if (t && (bothNow || t.today_min > 0)) {
    const pair = s.people.map((p) => `<span style="background:${color(p.slot)}">${initial(p.name)}</span>`).join("");
    const title = bothNow ? "You're both reading right now." : `You read together for ${hm(t.today_min)} today.`;
    const sub = bothNow
      ? `<span class="live"></span><span>${t.today_min ? `${hm(t.today_min)} together so far today` : "Same moment, different rooms."}</span>`
      : `${ic("heart")}<span>${hm(t.week_min)} together this week</span>`;
    banner = `<div class="together"><div class="pair" aria-hidden="true">${pair}</div><div class="together-text"><div class="together-title">${title}</div><div class="together-sub">${sub}</div></div></div>`;
  }
  $("together").innerHTML = banner;
}

function renderBooks(s) {
  if (!s.books.length) {
    $("books").innerHTML = `<p class="empty">Nothing on the go right now. Finished books live on your Shelves.</p>`;
    return;
  }
  $("books").innerHTML = s.books.map((b) => {
    const readers = [...b.readers].sort((a, c) => slotOf(a.username) - slotOf(c.username));
    const rows = readers.map((r) => {
      const meta = r.done
        ? [r.done === "finished" ? "Finished" : "Put down", ago(r.ts, s.now)].join(" · ")
        : [r.section ? `section ${r.section}` : null, ago(r.ts, s.now), hoursLeft(r.eta_hours)].filter(Boolean).join(" · ");
      return `<div class="reader">
        <div class="who"><span class="dotsw" style="background:${color(slotOf(r.username))}"></span><span>${esc(nameOf(r.username))}</span></div>
        <div class="bar" role="img" aria-label="${esc(nameOf(r.username))}: ${pct(r.pct)}"><div style="width:${(r.pct * 100).toFixed(1)}%;background:${color(slotOf(r.username))}"></div></div>
        <div class="pctv">${pct(r.pct)}</div>
        <div class="meta">${esc(meta)}</div></div>`;
    }).join("");

    let gap = "";
    if (b.shared && b.gap !== null) {
      const other = readers.find((r) => r.username !== s.me);
      const pname = esc(nameOf(other.username));
      const pts = Math.round(Math.abs(b.gap) * 100);
      if (b.spoiler) {
        gap = `<div class="spoiler" role="note">${ic("triangle-alert")}<span><strong>Spoiler zone:</strong> ${b.gap > 0
          ? `you're ${pts}% ahead of ${pname}. Careful what you say!`
          : `${pname} is ${pts}% ahead. Don't let them tell you anything!`}</span></div>`;
      } else if (pts === 0) {
        gap = `<div class="gapline">${ic("equal")}Neck and neck</div>`;
      } else {
        gap = `<div class="gapline">${ic("footprints")}${b.gap > 0 ? `You're ${pts}% ahead of ${pname}` : `${pname} is ${pts}% ahead of you`}</div>`;
      }
    }

    const titleBlock = b.named
      ? `<h3>${esc(b.title)}</h3>${b.authors ? `<div class="by">${esc(b.authors.replace(/\n/g, ", "))}</div>` : ""}`
      : `<h3 class="untitled">Untitled book</h3><div class="by hint">Readest didn't send a title for this one.</div>`;
    const rename = b.named
      ? `<button class="ibtn rename" type="button" data-doc="${esc(b.document)}" data-title="${esc(b.title)}" aria-label="Rename book">${ic("pencil-line")}</button>`
      : `<button class="btn-pill rename" type="button" data-doc="${esc(b.document)}" data-title="">${ic("pencil-line")}Name this book</button>`;

    const open = openBooks.has(b.document);
    return `<article class="card book">
      <div class="book-head">${cover(b.cover, b.named ? b.title : "")}<div class="book-titles">${titleBlock}</div>${rename}</div>
      <div class="readers">${rows}</div>
      ${gap}
      <div class="disclosure">
        <button type="button" class="sec-toggle" data-doc="${esc(b.document)}" aria-expanded="${open}">Time per section${ic(open ? "chevron-up" : "chevron-down")}</button>
        ${open ? `<div class="disclosure-body" id="secs-${esc(b.document)}">${sectionCache.has(b.document) ? sectionsHtml(b.document) : `<div class="loading">${ic("loader-circle")}Loading…</div>`}</div>` : ""}
      </div></article>`;
  }).join("");

  $("books").querySelectorAll(".rename").forEach((btn) => btn.addEventListener("click", async () => {
    const title = window.prompt("What's this book called?", btn.dataset.title || "");
    if (title === null || !title.trim()) return;
    const r = await api(`/api/book/${encodeURIComponent(btn.dataset.doc)}/title`, { method: "POST", body: JSON.stringify({ title: title.trim() }) });
    if (!r.ok) return toast(r.data.error || "Couldn't save the name");
    toast("Saved");
    refresh();
  }));
  $("books").querySelectorAll(".sec-toggle").forEach((btn) => btn.addEventListener("click", () => {
    const doc = btn.dataset.doc;
    if (openBooks.has(doc)) openBooks.delete(doc); else openBooks.add(doc);
    renderBooks(state);
    if (openBooks.has(doc)) loadSections(doc);
  }));
  $("books").querySelectorAll(".sec-view").forEach((btn) => btn.addEventListener("click", () => {
    const doc = btn.dataset.doc;
    if (tableBooks.has(doc)) tableBooks.delete(doc); else tableBooks.add(doc);
    renderBooks(state);
  }));
}

async function loadSections(doc) {
  const r = await api(`/api/book/${encodeURIComponent(doc)}/sections`);
  if (!r.ok) return;
  sectionCache.set(doc, r.data);
  if (openBooks.has(doc)) renderBooks(state);
}

function sectionsHtml(doc) {
  const data = sectionCache.get(doc);
  const ps = state.people;
  if (!data || !data.sections.length) return `<p class="empty">No section data yet.</p>`;
  const legend = `<div class="legend">${ps.map((p) => `<span><i class="sq" style="background:${color(p.slot)}"></i>${esc(p.is_me ? "You" : p.name)}</span>`).join("")}</div>`;
  const asTable = tableBooks.has(doc);
  let body;
  if (asTable) {
    body = `<div class="dtable" style="grid-template-columns:1fr ${ps.map(() => "1fr").join(" ")}">
      <div class="h">Section</div>${ps.map((p) => `<div class="h r">${esc(p.is_me ? "You" : p.name)}</div>`).join("")}
      ${data.sections.map((sec) => `<div class="s">§${sec.section}</div>${ps.map((p) => `<div class="r">${sec.minutes[p.username] ? hm(sec.minutes[p.username]) : "—"}</div>`).join("")}`).join("")}</div>`;
  } else {
    const max = Math.max(1, ...data.sections.flatMap((sec) => ps.map((p) => sec.minutes[p.username] ?? 0)));
    body = `<div class="sec-list">${data.sections.map((sec) => `<div class="sec-row"><div class="lbl">§${sec.section}</div><div class="sec-bars">${ps.map((p) => {
      const m = sec.minutes[p.username] ?? 0;
      return `<div class="sec-bar"><div style="width:calc(${((m / max) * 100).toFixed(1)}% - ${((m / max) * 40).toFixed(1)}px);background:${color(p.slot)}"></div><span>${m ? hm(m) : ""}</span></div>`;
    }).join("")}</div></div>`).join("")}</div>`;
  }
  const toggle = `<button type="button" class="link-btn sec-view" data-doc="${esc(doc)}">${ic(asTable ? "chart-bar" : "table")}${asTable ? "Show as chart" : "Show as table"}</button>`;
  return legend + body + toggle;
}

function renderHabits(s) {
  const ps = s.people;
  const rows = [
    ["Today", (p) => [hm(p.stats.today_min)]],
    ["This week", (p) => [hm(p.stats.week_min)]],
    ["Streak", (p) => [p.stats.streak_days ? `${p.stats.streak_days} day${p.stats.streak_days === 1 ? "" : "s"}` : "–"]],
    ["Sessions (7 days)", (p) => [String(p.stats.sessions_7d)]],
    ["Average session", (p) => [p.stats.avg_session_min ? hm(p.stats.avg_session_min) : "–"]],
    ["Time per page (7 days)", (p) => (p.pages_7d.sec_per_page != null ? [fmtSec(p.pages_7d.sec_per_page), `${p.pages_7d.count} pages`] : ["–"])],
    ["Pace", (p) => [p.stats.speed_pct_per_hour ? `${(p.stats.speed_pct_per_hour * 100).toFixed(1)}% / hour` : "–"]],
  ];
  let html = `<div class="habits-grid"><div class="hd"></div>${ps.map((p) => `<div class="hd"><span class="dotsw" style="background:${color(p.slot)}"></span>${esc(p.is_me ? "You" : p.name)}</div>`).join("")}`;
  for (const [label, f] of rows) {
    html += `<div class="lbl">${label}</div>` + ps.map((p) => { const [v, sub] = f(p); return `<div>${esc(v)}${sub ? `<span class="subv">${esc(sub)}</span>` : ""}</div>`; }).join("");
  }
  html += "</div>";
  if (s.together) html += `<div class="together-row">${ic("heart")}<strong>Together:</strong><span>${hm(s.together.week_min)} this week</span><span class="sep">·</span><span>${hm(s.together.month_min)} in 4 weeks</span></div>`;
  $("habits").innerHTML = html;
}

// ---------------- charts ----------------
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
function svgText(x, y, text, attrs = {}) { const t = svgEl("text", { x, y, ...attrs }); t.textContent = text; return t; }

const tip = $("tooltip");
function showTip(evt, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const pt = evt.touches?.[0] ?? evt;
  const x = Math.max(8, Math.min(pt.clientX - tip.offsetWidth / 2, window.innerWidth - tip.offsetWidth - 8));
  const y = Math.max(8, pt.clientY - tip.offsetHeight - 14);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
const hideTip = () => { tip.hidden = true; };
const sw = (slot) => `<span class="tsw" style="background:${color(slot)}"></span>`;

function niceMax(v) {
  if (v <= 15) return 15;
  const step = v <= 60 ? 15 : v <= 180 ? 30 : 60;
  return Math.ceil(v / step) * step;
}

function renderDaily(s) {
  const ps = s.people;
  const days = ps[0]?.stats.last14 ?? [];
  $("daily-legend").innerHTML = ps.map((p) => `<span><i class="sq" style="background:${color(p.slot)}"></i>${esc(p.is_me ? "You" : p.name)}</span>`).join("");
  const toggle = $("daily-toggle");
  toggle.innerHTML = `${ic(dailyTable ? "chart-bar" : "table")}<span>${dailyTable ? "Show as chart" : "Show as table"}</span>`;

  if (dailyTable) {
    $("daily").innerHTML = `<div class="dtable" style="grid-template-columns:1.4fr ${ps.map(() => "1fr").join(" ")}">
      <div class="h">Day</div>${ps.map((p) => `<div class="h r">${esc(p.is_me ? "You" : p.name)}</div>`).join("")}
      ${days.map((d, i) => `<div>${i === days.length - 1 ? "Today" : new Date(`${d.day}T00:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}</div>${ps.map((p) => `<div class="r">${p.stats.last14[i].min ? hm(p.stats.last14[i].min) : "—"}</div>`).join("")}`).join("")}</div>`;
    return;
  }

  const W = 340, top = 4, base = 118, L = 28, R = 336;
  const max = niceMax(Math.max(1, ...ps.flatMap((p) => p.stats.last14.map((d) => d.min))));
  const box = svgEl("svg", { viewBox: `0 0 ${W} 150`, role: "img", "aria-label": "Grouped bar chart of minutes read per day over 14 days" });
  for (let i = 0; i <= 3; i++) {
    const v = (max / 3) * i, y = base - ((base - top) * v) / max;
    box.append(svgEl("line", { x1: L, x2: R, y1: y, y2: y, class: "gridl" }), svgText(22, y + 3, `${Math.round(v)}m`, { "text-anchor": "end" }));
  }
  const gw = (R - L) / days.length;
  const bw = 7;
  days.forEach((d, i) => {
    const gx = L + i * gw;
    const hl = svgEl("rect", { x: gx + gw / 2 - 11, y: top, width: 22, height: base - top, rx: 3, fill: "transparent" });
    box.append(hl);
    ps.forEach((p, j) => {
      const m = p.stats.last14[i].min;
      if (!m) return;
      const h = Math.max(1.5, ((base - top) * m) / max);
      const x = gx + gw / 2 - (ps.length * bw + (ps.length - 1)) / 2 + j * (bw + 1);
      box.append(svgEl("rect", { x, y: base - h, width: bw, height: h, rx: 1.5, fill: color(p.slot) }));
    });
    const isToday = i === days.length - 1;
    if (i % 2 === 1 || isToday) {
      const date = new Date(`${d.day}T00:00:00`);
      box.append(svgText(gx + gw / 2, 134, isToday ? "Today" : date.toLocaleDateString([], { weekday: "short" }),
        { "text-anchor": isToday ? "end" : "middle", ...(isToday ? { "font-weight": 600, x: R } : {}) }));
    }
    const hit = svgEl("rect", { x: gx, y: 0, width: gw, height: 140, class: "hit" });
    const date = isToday ? "Today" : new Date(`${d.day}T00:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
    const show = (e) => {
      hl.setAttribute("fill", "var(--surface-2)");
      showTip(e, `<strong>${date}</strong><br>${ps.map((p) => `${sw(p.slot)}${esc(p.is_me ? "You" : p.name)} ${p.stats.last14[i].min ? hm(p.stats.last14[i].min) : "—"}`).join(" &nbsp; ")}`);
    };
    hit.addEventListener("pointermove", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", () => { hl.setAttribute("fill", "transparent"); hideTip(); });
    box.append(hit);
  });
  $("daily").replaceChildren(box);
}

function renderHeat(s) {
  if (!heatFor || !person(heatFor)) heatFor = s.me;
  $("heat-tabs").innerHTML = s.people.map((p) =>
    `<button role="tab" aria-selected="${p.username === heatFor}" data-u="${esc(p.username)}"><span class="dotsw" style="background:${color(p.slot)}"></span>${esc(p.is_me ? "You" : p.name)}</button>`).join("");
  $("heat-tabs").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { heatFor = b.dataset.u; renderHeat(state); }));

  const heat = person(heatFor).stats.heat;
  const max = Math.max(0, ...heat.flat());
  const rows = heat.map((row, d) => `<div class="heat-row"><div class="lbl">${WEEKDAYS[d]}</div>${row.map((m, h) => {
    const step = m <= 0 || max === 0 ? 0 : Math.max(1, Math.ceil((m / max) * 6));
    return `<div class="c" data-d="${d}" data-h="${h}" data-m="${m}" style="background:var(--seq-${step})"></div>`;
  }).join("")}</div>`).join("");
  $("heat").innerHTML = `<div class="heat-grid">${rows}</div><div class="heat-hours"><span></span><span>00</span><span>06</span><span>12</span><span>18</span></div>`;
  $("heat").querySelectorAll(".c").forEach((c) => {
    const show = (e) => {
      const d = +c.dataset.d, h = +c.dataset.h, m = +c.dataset.m;
      showTip(e, `<strong>${WEEKDAYS[d]} ${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00</strong> · ${m ? hm(m) : "nothing"}`);
    };
    c.addEventListener("pointermove", show);
    c.addEventListener("pointerdown", show);
    c.addEventListener("pointerleave", hideTip);
  });
  $("heat-scale").innerHTML = `less ${[0, 1, 2, 3, 4, 5, 6].map((i) => `<i style="background:var(--seq-${i})"></i>`).join("")} more`;
}

// ---------------- sessions ----------------
function sessionFacts(x) {
  if (x.pushes <= 1) return `${hm(x.minutes)} · ${pct(x.end_pct)} · one update`;
  const d = (x.end_pct ?? 0) - (x.start_pct ?? 0);
  const moved = `${pct(x.start_pct)} → ${pct(x.end_pct)}${Math.abs(d) >= 0.005 ? ` (${d > 0 ? "+" : ""}${(d * 100).toFixed(1)}%)` : ""}`;
  return [hm(x.minutes), moved, x.sec_per_page != null ? `${fmtSec(x.sec_per_page)} / page` : null,
    x.jumps ? `${x.jumps} jump${x.jumps === 1 ? "" : "s"}` : "no jumps"].filter(Boolean).join(" · ");
}

function renderSessions(s) {
  $("sessions").innerHTML = s.sessions.map((x) => {
    const open = openSessions.has(x.id);
    return `<div class="srow">
      <button type="button" aria-expanded="${open}" data-id="${x.id}">
        <span class="sw" style="background:${color(slotOf(x.username))}"></span>
        <span class="s-main">
          <span class="s-title"><strong>${esc(nameOf(x.username))}</strong><span class="dotsep"> · </span><em class="t">${esc(x.title)}</em></span>
          <span class="s-when">${dayName(x.start_ts, s.now)} ${clock(x.start_ts)}–${clock(x.end_ts)} ·${ic(DEVICE_ICON[x.device_kind] || "smartphone")}${DEVICE[x.device_kind] || "device"}</span>
          <span class="s-facts">${esc(sessionFacts(x))}</span>
        </span>
        ${ic(open ? "chevron-up" : "chevron-down", "chev")}
      </button>
      ${open ? `<div class="s-body" id="sbody-${x.id}">${sessionCache.has(x.id) ? "" : `<div class="loading">${ic("loader-circle")}Loading…</div>`}</div>` : ""}
    </div>`;
  }).join("");
  $("sessions").querySelectorAll(".srow > button").forEach((btn) => btn.addEventListener("click", () => {
    const id = +btn.dataset.id;
    if (openSessions.has(id)) openSessions.delete(id); else openSessions.add(id);
    renderSessions(state);
  }));
  for (const id of openSessions) {
    const body = document.getElementById(`sbody-${id}`);
    if (!body) continue;
    if (sessionCache.has(id)) renderTimeline(body, sessionCache.get(id));
    loadSession(id);
  }
}

async function loadSession(id) {
  const r = await api(`/api/session/${id}`);
  const body = document.getElementById(`sbody-${id}`);
  if (!r.ok) { if (body) body.innerHTML = `<div class="error-line">${ic("circle-alert")}Couldn't load this session.</div>`; return; }
  sessionCache.set(id, r.data);
  if (body) renderTimeline(body, r.data);
}

const KIND = { start: "Started", page: "Page turn", jump: "Jumped ahead", back: "Jumped back", still: "Paused or left the app" };

function renderTimeline(body, d) {
  const pts = d.points.filter((p) => p.pct != null);
  if (pts.length < 2) {
    body.innerHTML = `<div class="info">${ic("info")}<span>Only one position update in this session, not enough to draw a timeline.</span></div>`;
    return;
  }
  const col = color(slotOf(d.username));
  const t0 = d.start_ts, t1 = Math.max(d.end_ts, t0 + 60);
  const lo = Math.min(...pts.map((p) => p.pct)), hi = Math.max(...pts.map((p) => p.pct));
  const pad = Math.max((hi - lo) * 0.08, 0.002);
  const ylo = Math.max(0, lo - pad), yhi = Math.min(1, hi + pad);
  const X = (ts) => 34 + ((ts - t0) / (t1 - t0)) * 278;
  const Y = (v) => 104 - ((v - ylo) / (yhi - ylo || 1)) * 94;
  const digits = yhi - ylo < 0.05 ? 1 : 0;

  // where in the book
  const chart = svgEl("svg", { viewBox: "0 0 320 130", role: "img", "aria-label": `Book position during this session, ${pct(d.start_pct)} to ${pct(d.end_pct)}` });
  for (const v of [lo, hi]) chart.append(svgEl("line", { x1: 34, x2: 312, y1: Y(v), y2: Y(v), class: "gridl" }), svgText(28, Y(v) + 3, `${(v * 100).toFixed(digits)}%`, { "text-anchor": "end" }));
  [[t0, "start", 34], [(t0 + t1) / 2, "middle", 173], [t1, "end", 312]].forEach(([ts, anchor, x]) => chart.append(svgText(x, 122, clock(ts), { "text-anchor": anchor })));
  const cross = svgEl("line", { y1: 8, y2: 106, stroke: "var(--ink-3)", "stroke-dasharray": "2 3" });
  chart.append(cross);
  chart.append(svgEl("path", { d: pts.map((p, i) => `${i ? "L" : "M"}${X(p.ts).toFixed(1)} ${Y(p.pct).toFixed(1)}`).join(" "), fill: "none", stroke: col, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  for (const p of pts.filter((p) => p.kind === "jump" || p.kind === "back")) {
    chart.append(svgEl("circle", { cx: X(p.ts), cy: Y(p.pct), r: 4.5, fill: "var(--surface)", stroke: col, "stroke-width": 2 }));
  }
  const dot = svgEl("circle", { r: 3.5, fill: col, stroke: "var(--surface)", "stroke-width": 1.5 });
  chart.append(dot);
  const place = (p) => {
    cross.setAttribute("x1", X(p.ts)); cross.setAttribute("x2", X(p.ts));
    dot.setAttribute("cx", X(p.ts)); dot.setAttribute("cy", Y(p.pct));
  };
  place(pts[pts.length - 1]);
  const hit = svgEl("rect", { x: 34, y: 0, width: 278, height: 112, class: "hit" });
  const move = (evt) => {
    const box = chart.getBoundingClientRect();
    const pt = evt.touches?.[0] ?? evt;
    const vx = ((pt.clientX - box.left) / box.width) * 320;
    const p = pts.reduce((a, q) => (Math.abs(X(q.ts) - vx) < Math.abs(X(a.ts) - vx) ? q : a), pts[0]);
    place(p);
    showTip(evt, `<strong>${clock(p.ts)}</strong> · ${(p.pct * 100).toFixed(1)}%${p.section ? ` · section ${p.section}` : ""}<br>${KIND[p.kind]}${p.page_s ? ` after ${fmtSec(p.page_s)}` : ""}`);
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", hideTip);
  chart.append(hit);

  // seconds per page
  const pages = d.points.filter((p) => p.page_s);
  const cap = Math.max(30, Math.ceil(Math.max(0, ...pages.map((p) => p.page_s)) / 30) * 30);
  const strip = svgEl("svg", { viewBox: "0 0 320 90", role: "img", "aria-label": "Seconds spent on each page" });
  strip.append(svgEl("line", { x1: 34, x2: 312, y1: 10, y2: 10, class: "gridl" }), svgEl("line", { x1: 34, x2: 312, y1: 76, y2: 76, class: "gridl" }),
    svgText(28, 13, `${cap}s`, { "text-anchor": "end" }), svgText(28, 79, "0", { "text-anchor": "end" }));
  for (const p of pages) {
    const h = Math.max(1.5, (Math.min(p.page_s, cap) / cap) * 66);
    const bar = svgEl("rect", { x: X(p.ts) - 1.25, y: 76 - h, width: 2.5, height: h, rx: 1, fill: col });
    const show = (e) => showTip(e, `<strong>${clock(p.ts)}</strong> · ${fmtSec(p.page_s)} on the page${p.section ? ` · section ${p.section}` : ""}`);
    bar.addEventListener("pointermove", show);
    bar.addEventListener("pointerdown", show);
    bar.addEventListener("pointerleave", hideTip);
    strip.append(bar);
  }

  body.innerHTML = `
    <div class="tiles">
      <div><span class="k">Reading time</span><span class="v">${hm(d.minutes)}</span></div>
      <div><span class="k">Pages turned</span><span class="v">${d.pages}</span></div>
      <div><span class="k">Typical page</span><span class="v">${fmtSec(d.sec_per_page)}</span></div>
      <div><span class="k">Jumps</span><span class="v">${d.jumps}</span></div>
    </div>
    <div class="s-chart"><h4>Where in the book</h4><div class="chart-box tl"></div>
      ${d.jumps ? `<div class="s-legend"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.6"></circle></svg>Jump: moved more than a few pages at once</div>` : ""}</div>
    <div class="s-chart"><h4>Seconds per page</h4><div class="chart-box strip"></div>
      ${pages.length ? "" : `<div class="s-legend">No page turns measured (pages flicked faster than 3 s, or only jumps).</div>`}</div>`;
  body.querySelector(".tl").append(chart);
  body.querySelector(".strip").append(strip);
}

// ---------------- activity ----------------
function renderActivity(s) {
  const titles = [...new Set([...s.books.filter((b) => b.named).map((b) => b.title)])].sort((a, b) => b.length - a.length);
  const italicise = (text) => {
    let out = esc(text);
    for (const t of titles) {
      const e = esc(t);
      const i = out.indexOf(e);
      if (i >= 0) { out = `${out.slice(0, i)}<em class="t">${e}</em>${out.slice(i + e.length)}`; break; }
    }
    return out;
  };
  $("activity").innerHTML = s.activity.length
    ? s.activity.map((a) => `<div class="act"><span class="ic">${ic(ACTIVITY_ICON[a.kind] || "info")}</span><div class="tx">${italicise(a.text)}</div><time datetime="${new Date(a.ts * 1000).toISOString()}">${ago(a.ts, s.now)}</time></div>`).join("")
    : `<p class="empty">Nothing yet. The first page turn shows up here.</p>`;
}

// ---------------- Shelves ----------------
function applyView() {
  $("dash").hidden = !DASH_VIEWS.includes(view);
  // Panels toggle with a class, not [hidden], so render() can still hide empty sections independently.
  document.querySelectorAll("#dash [data-panel]").forEach((el) => el.classList.toggle("off-tab", el.dataset.panel !== view));
  hideTip();
  $("shelves-view").hidden = view !== "shelves";
  $("settings-view").hidden = view !== "settings";
  $("viewtabs").hidden = view === "settings";
  $("settings-btn").setAttribute("aria-pressed", String(view === "settings"));
  document.querySelectorAll("#viewtabs button").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.view === view)));
}

let lastView = "today";
function setView(v) {
  if (v === view) return;
  if (view !== "settings") lastView = view;
  view = v;
  history.replaceState(null, "", v === "today" ? "#" : `#${v}`);
  applyView();
  if (v === "shelves") loadLibrary();
  if (v === "settings") loadSettings();
  window.scrollTo({ top: 0 });
}

async function loadLibrary() {
  const r = await api("/api/library");
  if (r.status === 401) return showLogin();
  if (!r.ok) return;
  lib = r.data;
  renderShelves();
}

const libPerson = (u) => lib.people.find((x) => x.username === u);
const libName = (u) => { const p = libPerson(u); return p ? (p.is_me ? "You" : p.name) : u; };

function renderShelves() {
  if (!lib) return;
  if (!shelfFor || !libPerson(shelfFor)) shelfFor = lib.me;
  const own = shelfFor === lib.me;
  const p = libPerson(shelfFor);
  const other = lib.people.find((x) => !x.is_me);

  $("shelf-people").innerHTML = lib.people.map((x) =>
    `<button role="tab" aria-selected="${x.username === shelfFor}" data-u="${esc(x.username)}"><span class="dotsw" style="background:${color(slotOf(x.username))}"></span>${esc(x.is_me ? "Your shelves" : `${x.name}'s shelves`)}</button>`).join("");
  $("shelf-people").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { shelfFor = b.dataset.u; renderShelves(); }));

  const y = p.year;
  $("year-line").innerHTML = `<strong>${y.year}</strong><span>${y.finished} finished · ${y.started} started · ${y.hours} h read</span>`;

  const mine = lib.entries.filter((e) => e.username === shelfFor);
  const by = (st) => mine.filter((e) => st.includes(e.status));
  const fill = (id, cnt, items, html, emptyText) => {
    $(cnt).textContent = items.length ? String(items.length) : "";
    $(id).innerHTML = items.length ? items.map(html).join("") : `<p class="empty">${emptyText}</p>`;
  };
  fill("shelf-reading", "cnt-reading", by(["reading"]), (e) => entryCard(e, own), "Nothing on the go right now.");
  fill("shelf-finished", "cnt-finished", by(["finished"]).sort((a, b) => (b.finished_ts ?? 0) - (a.finished_ts ?? 0)), (e) => entryCard(e, own), "No finished books yet.");
  fill("shelf-paused", "cnt-paused", by(["paused", "abandoned"]), (e) => entryCard(e, own), "Nothing paused or put down.");

  $("wish-form").hidden = !own;
  const wish = lib.wishlist.filter((w) => w.username === shelfFor);
  fill("shelf-wish", "cnt-wish", wish, (w) => `<article class="card entry">${cover(w.cover, w.title, "lg")}<div class="entry-body">
      <div class="entry-top"><div><h3>${esc(w.title)}</h3>${w.authors ? `<div class="by">${esc(w.authors)}</div>` : ""}</div>
      ${own ? `<button class="ibtn wish-del" type="button" data-id="${w.id}" aria-label="Remove from want to read">${ic("x")}</button>` : ""}</div>
      ${w.note ? `<div class="why">“${esc(w.note)}”</div>` : ""}
      <div class="meta">Added ${shortDate(w.created_at)}</div></div></article>`,
    own ? `Add books you want to read. ${esc(other?.name ?? "Your partner")} sees them too.` : "Nothing here yet.");

  bindShelfActions();
}

function entryCard(e, own) {
  const col = color(slotOf(e.username));
  const time = e.minutes ? `${hm(e.minutes)} over ${e.sessions} session${e.sessions === 1 ? "" : "s"}` : null;
  const meta = {
    reading: [e.started_ts ? `Started ${shortDate(e.started_ts)}` : null, `last read ${ago(e.last_ts, lib.now)}`, time],
    finished: [e.finished_ts ? `Finished ${shortDate(e.finished_ts)}` : null, e.days_to_finish ? `${e.days_to_finish} day${e.days_to_finish === 1 ? "" : "s"}` : null, time],
    paused: [`Last read ${ago(e.last_ts, lib.now)} at ${pct(e.pct)}`, time],
    abandoned: [`Put down at ${pct(e.pct)}`, time],
  }[e.status].filter(Boolean).join(" · ");
  const badge = e.status === "paused" ? `<span class="badge">${ic("pause")}Paused</span>` : e.status === "abandoned" ? `<span class="badge">${ic("book-down")}Put down</span>` : "";
  const bar = e.status === "reading" || e.status === "paused"
    ? `<div class="solo-bar"><div class="bar"><div style="width:${(e.pct * 100).toFixed(1)}%;background:${col}"></div></div><span>${pct(e.pct)}</span></div>` : "";

  const otherE = lib.entries.find((x) => x.document === e.document && x.username !== e.username);
  const chip = otherE
    ? `<span class="chip"><span style="background:${color(slotOf(otherE.username))}">${initial(libPerson(otherE.username)?.name)}</span>${esc(libName(otherE.username))}: ${otherE.status === "finished" ? `finished${otherE.rating ? ` ${stars(otherE.rating)}` : ""}` : pct(otherE.pct)}</span>` : "";

  const rating = own
    ? `<div class="stars" role="radiogroup" aria-label="Your rating">${[1, 2, 3, 4, 5].map((n) =>
        `<button type="button" class="star${e.rating >= n ? " on" : ""}" data-doc="${esc(e.document)}" data-n="${n}" role="radio" aria-checked="${e.rating === n}" aria-label="${n} star${n === 1 ? "" : "s"}">${e.rating >= n ? "★" : "☆"}</button>`).join("")}</div>`
    : e.rating ? `<div class="stars-ro" aria-label="${e.rating} out of 5 stars">${stars(e.rating)}</div>` : "";

  let note = "";
  const key = `${e.username}:${e.document}`;
  if (e.review && e.review_hidden && !revealed.has(key)) {
    note = `<button type="button" class="hidden-note" data-key="${esc(key)}">${ic("eye-off")}<span>Note hidden until you finish this book · <u>tap to read anyway</u></span></button>`;
  } else if (e.review) {
    note = `<div class="note"><q>${esc(e.review)}</q><span class="by">— ${own ? "your note" : `${esc(libName(e.username))}'s note`}</span></div>`;
  }

  let actions = "";
  if (own) {
    const doc = esc(e.document);
    const a = [`<button type="button" class="text-btn act-note" data-doc="${doc}" data-text="${esc(e.review ?? "")}">${ic("pencil-line")}${e.review ? "Edit note" : "Add a note"}</button>`,
      `<button type="button" class="text-btn act-cover" data-doc="${doc}">${ic("image")}Cover</button>`];
    if (e.status === "reading" || e.status === "paused") {
      a.push(`<button type="button" class="text-btn act-status" data-doc="${doc}" data-status="finished" data-msg="Marked finished. Time to talk about the ending.">${ic("book-check")}Mark finished</button>`,
        `<button type="button" class="text-btn act-status" data-doc="${doc}" data-status="abandoned" data-msg="Put down">${ic("book-down")}Put down</button>`);
    }
    if (e.status === "finished" || e.status === "abandoned") {
      a.push(`<button type="button" class="text-btn act-status" data-doc="${doc}" data-status="${e.status_manual ? "auto" : "reading"}" data-msg="Welcome back">${ic("book-open")}Back to reading</button>`);
    }
    actions = `<div class="actions">${a.join("")}</div>`;
  }

  const title = e.title ? `<h3>${esc(e.title)}</h3>` : `<h3 class="untitled">Untitled book</h3>`;
  return `<article class="card entry">${cover(e.cover, e.title || "", "lg")}<div class="entry-body">
    <div class="entry-top"><div>${title}${e.authors ? `<div class="by">${esc(e.authors.replace(/\n/g, ", "))}</div>` : ""}</div>${badge}</div>
    ${bar}<div class="meta">${esc(meta)}</div>${chip}${rating}${note}${actions}</div></article>`;
}

async function saveEntry(doc, body, msg) {
  const r = await api(`/api/library/${encodeURIComponent(doc)}`, { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) { toast(r.data.error || "Couldn't save"); return; }
  if (msg) toast(msg);
  await loadLibrary();
}

function bindShelfActions() {
  const root = $("shelves-view");
  root.querySelectorAll(".star").forEach((b) => b.addEventListener("click", () => {
    const e = lib.entries.find((x) => x.document === b.dataset.doc && x.username === lib.me);
    const n = +b.dataset.n;
    saveEntry(b.dataset.doc, { rating: e && e.rating === n ? 0 : n }, e && e.rating === n ? "Rating cleared" : "Rated");
  }));
  root.querySelectorAll(".act-note").forEach((b) => b.addEventListener("click", () => {
    const text = window.prompt("Your note on this book (leave empty to remove):", b.dataset.text);
    if (text !== null) saveEntry(b.dataset.doc, { review: text }, text.trim() ? "Note saved" : "Note removed");
  }));
  root.querySelectorAll(".act-status").forEach((b) => b.addEventListener("click", () => saveEntry(b.dataset.doc, { status: b.dataset.status }, b.dataset.msg)));
  root.querySelectorAll(".act-cover").forEach((b) => b.addEventListener("click", async () => {
    const url = window.prompt("Paste a link to a cover image (https://…). Leave empty to look it up automatically.", "");
    if (url === null) return;
    const r = await api(`/api/book/${encodeURIComponent(b.dataset.doc)}/cover`, { method: "POST", body: JSON.stringify({ url: url.trim() }) });
    if (!r.ok) return toast(r.data.error || "Couldn't change the cover");
    toast(url.trim() ? "Cover updated" : "Looking up the cover…");
    setTimeout(loadLibrary, url.trim() ? 0 : 2500);
  }));
  root.querySelectorAll(".hidden-note").forEach((b) => b.addEventListener("click", () => { revealed.add(b.dataset.key); renderShelves(); }));
  root.querySelectorAll(".wish-del").forEach((b) => b.addEventListener("click", async () => {
    const r = await api(`/api/wishlist/${b.dataset.id}`, { method: "DELETE" });
    if (r.ok) { toast("Removed"); loadLibrary(); } else toast("Couldn't remove it");
  }));
}

// ---------------- theme (auto → light → dark) ----------------
const THEMES = { auto: ["sun-moon", "automatic (follows your device)"], light: ["sun", "light"], dark: ["moon", "dark"] };
function currentTheme() {
  try { const t = localStorage.getItem("coread-theme"); return t === "light" || t === "dark" ? t : "auto"; } catch { return "auto"; }
}
function applyTheme(t) {
  if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  try { if (t === "auto") localStorage.removeItem("coread-theme"); else localStorage.setItem("coread-theme", t); } catch { /* private mode */ }
  document.querySelectorAll("#theme-seg button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.theme === t)));
  const dark = t === "dark" || (t === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", dark ? "#1A1613" : "#F5EFE4"));
}
applyTheme(currentTheme());

// ---------------- settings & setup ----------------
async function loadSettings() {
  if (!settings) {
    const r = await api("/api/settings");
    if (r.status === 401) return showLogin();
    if (!r.ok) { $("settings-body").innerHTML = `<div class="error-line">${ic("circle-alert")}Couldn't load your settings.</div>`; return; }
    settings = r.data;
  }
  renderSettings();
}

const kv = (label, value) => `<div class="kv"><span class="k">${esc(label)}</span><span class="v">${esc(value)}</span>
  <button type="button" class="copy" data-copy="${esc(value)}" aria-label="Copy ${esc(label)}">${ic("copy")}</button></div>`;

function renderSettings() {
  const s = settings;
  const partnerName = s.partners[0] || "your partner";
  const theme = currentTheme();
  $("settings-lede").textContent = `Signed in as ${s.name}. Everything you need to connect a new device is below.`;

  const appearance = `<section class="card set-card" aria-labelledby="set-look">
    <h2 id="set-look">${ic("sun-moon")}Appearance</h2>
    <div class="setting-row"><div class="lbl">Theme<small>Each device remembers its own choice.</small></div>
      <div id="theme-seg" class="seg small" role="tablist" aria-label="Theme">
        ${Object.entries(THEMES).map(([k, [icon]]) => `<button role="tab" data-theme="${k}" aria-selected="${k === theme}">${ic(icon)}${k === "auto" ? "Automatic" : k[0].toUpperCase() + k.slice(1)}</button>`).join("")}
      </div></div>
  </section>`;

  const readest = `<section class="card set-card" aria-labelledby="set-readest">
    <h2 id="set-readest">${ic("book-open")}Connect Readest</h2>
    <p class="muted">Do this once on every phone, tablet and PC you read on. Your reading position then syncs between your own devices, and coread sees it.</p>
    <ol class="steps">
      <li>Install <strong>Readest</strong> from <a href="https://readest.com" target="_blank" rel="noopener">readest.com</a> (Android and Windows).</li>
      <li>In Readest open <span class="path">Settings → Integrations → KOReader Sync</span>.</li>
      <li>Fill in the server and your username exactly as written:
        ${kv("Server URL", s.server_url)}
        ${kv("Username", s.username)}
        <p class="muted" style="margin-top:8px">Password: pick one the first time and use the same one on every device. The first <strong>Connect</strong> creates your account; the button then says <em>Sync as ${esc(s.username)}</em>.</p></li>
      <li>Then set:
        <ul class="notif-list" style="margin-top:8px">
          <li>${ic("check")}<span><strong>Send Document Metadata</strong>: on (this is how book titles and covers appear)</span></li>
          <li>${ic("check")}<span><strong>Device Name</strong>: <span class="tag">Phone</span> <span class="tag">Tablet</span> or <span class="tag">PC</span>, so the right icon shows</span></li>
          <li>${ic("check")}<span><strong>Sync Strategy</strong>: <em>Ask on conflict</em> (or <em>Always use latest</em> to jump to your newest page silently)</span></li>
          <li>${ic("check")}<span><strong>Checksum Method</strong>: leave on <em>File Content</em></span></li>
        </ul></li>
      <li>Open a book and turn a page. Within a few seconds you show up on the Today tab.</li>
    </ol>
    <div class="warn-note">${ic("triangle-alert")}<span><strong>Reading the same book?</strong> Send ${esc(partnerName)} the exact EPUB file rather than downloading it separately. coread recognises a book by its file contents, so two different copies count as two books.</span></div>
  </section>`;

  const notif = `<section class="card set-card" aria-labelledby="set-notif">
    <h2 id="set-notif">${ic("bell-ring")}Notifications</h2>
    <p class="muted">coread sends notifications straight to this app. Turn them on once on each phone or PC where you want them.</p>
    <div id="push-box"><p class="muted">Checking this device…</p></div>
    <p class="muted">You'll hear when ${esc(partnerName)} starts a new book or starts reading after a break, finishes a section or a book, rates a book, adds something to their want-to-read list, or nudges you. You'll also hear when you're both reading at the same time, get a spoiler warning when you're far ahead, and a recap every Sunday evening.</p>
  </section>`;

  const install = `<section class="card set-card" aria-labelledby="set-install">
    <h2 id="set-install">${ic("download")}Put coread on your home screen</h2>
    <ul class="notif-list">
      <li>${ic("smartphone")}<span><strong>Android (Chrome):</strong> open this page, tap <span class="path">⋮ → Add to home screen</span> (or <em>Install app</em>).</span></li>
      <li>${ic("monitor")}<span><strong>Windows (Edge or Chrome):</strong> click the install icon at the right of the address bar, or <span class="path">⋯ → Apps → Install this site as an app</span>.</span></li>
    </ul>
    ${kv("Page address", s.server_url)}
  </section>`;

  const faqs = [
    ["Readest says “Registration is closed”", `Only the two coread usernames can sign up, and they're case-sensitive. Yours is exactly <strong>${esc(s.username)}</strong>.`],
    ["Readest says “Invalid credentials”", "Your account already exists with a different password. Use the same password you set on your first device."],
    ["A book shows as “Untitled book”", "Turn on <strong>Send Document Metadata</strong> in Readest's KOReader Sync settings, then turn a page. You can also tap the pencil on the book card to name it yourself."],
    ["We're reading the same book but it shows up twice", "Your files are different copies. Send each other the exact same EPUB file and open that one."],
    ["It says I'm away while I'm reading", "Only page turns count as reading, and Readest reports about 5 seconds after you stop on a page. Turn a page and wait a moment."],
    ["Readest keeps asking which page to jump to", "That's your own devices syncing with each other (for example phone vs PC). Choose the newer one, or set Sync Strategy to <em>Always use latest</em>."],
    ["Notifications don't arrive", "Use <em>Send a test notification</em> above. If the test arrives but others don't: you're only notified about your partner's reading, not your own. On Android, also check <span class=\"path\">Settings → Apps → Chrome → Notifications</span> is on and that Chrome's battery use isn't restricted. If notifications were blocked, allow them in the browser's site settings for this page, then turn them on here again."],
    ["The cover is wrong or missing", "On the Shelves tab, tap <strong>Cover</strong> on the book and paste a link to an image, or leave it empty to look it up again."],
  ];
  const help = `<section class="card set-card" aria-labelledby="set-help">
    <h2 id="set-help">${ic("life-buoy")}Troubleshooting</h2>
    <div class="faq">${faqs.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join("")}</div>
  </section>`;

  const account = `<section class="card set-card" aria-labelledby="set-account">
    <h2 id="set-account">${ic("user-round")}Account</h2>
    <p>Signed in as <strong>${esc(s.name)}</strong> (username <strong>${esc(s.username)}</strong>) on this device.</p>
    <div class="btn-row"><button type="button" id="logout" class="btn-outline" style="padding:0 18px">${ic("log-out")}Sign out</button></div>
  </section>`;

  $("settings-body").innerHTML = appearance + notif + readest + install + help + account;

  $("settings-body").querySelectorAll("#theme-seg button").forEach((b) => b.addEventListener("click", () => { applyTheme(b.dataset.theme); }));
  $("settings-body").querySelectorAll(".copy").forEach((b) => b.addEventListener("click", () => copyText(b.dataset.copy)));
  $("logout").addEventListener("click", async () => {
    await disablePush(true); // this device stops getting this account's notifications
    await api("/api/logout", { method: "POST" });
    settings = null;
    showLogin();
  });
  renderPushBox();
}

// ---------------- notifications (Web Push) ----------------
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
let swRegP = null;
function swReady() {
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);
  swRegP ??= navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready).catch(() => null);
  return swRegP;
}
const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4)), (c) => c.charCodeAt(0));
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "browser";
  return `${os} · ${br}`;
}
async function currentSub() {
  const reg = await swReady();
  return reg ? reg.pushManager.getSubscription() : null;
}
const sendSub = (sub) => api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ ...sub.toJSON(), label: deviceLabel() }) });

async function enablePush() {
  if (!settings?.push_key) return toast("Notifications aren't set up on the server yet");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { toast(perm === "denied" ? "Notifications are blocked for this page" : "Notifications weren't allowed"); return renderPushBox(); }
  const reg = await swReady();
  if (!reg) return toast("This browser can't receive notifications");
  const key = keyBytes(settings.push_key);
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with a different server key can't receive our messages.
  if (sub?.options?.applicationServerKey && !sameBytes(new Uint8Array(sub.options.applicationServerKey), key)) { await sub.unsubscribe(); sub = null; }
  try {
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch {
    return toast("Couldn't turn notifications on in this browser");
  }
  const r = await sendSub(sub);
  if (!r.ok) return toast(r.data.error || "Couldn't save this device");
  settings = null;
  await loadSettings();
  toast("Notifications are on for this device");
}

async function disablePush(quiet = false) {
  const sub = await currentSub().catch(() => null);
  if (!sub) return;
  await api("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) });
  await sub.unsubscribe().catch(() => undefined);
  if (!quiet) { settings = null; await loadSettings(); toast("Notifications are off for this device"); }
}

/** Keep the server's copy of this browser's subscription current (they can rotate, or another person may have signed in). */
async function syncPush() {
  if (!pushSupported() || Notification.permission !== "granted") return;
  const sub = await currentSub().catch(() => null);
  if (sub) await sendSub(sub);
}

async function renderPushBox() {
  const box = $("push-box");
  if (!box) return;
  const s = settings;
  const devices = s.push_devices || [];
  const others = devices.length
    ? `<p class="muted" style="margin-top:10px">On for ${devices.length} device${devices.length === 1 ? "" : "s"}: ${devices.map((d) => esc(d.label || "a device")).join(", ")}.</p>`
    : "";
  let html;
  if (!pushSupported()) {
    html = `<div class="warn-note">${ic("bell-off")}<span>This browser can't show notifications. On an iPhone, add coread to your home screen first and open it from there.</span></div>`;
  } else if (!s.push_key) {
    html = `<div class="warn-note">${ic("bell-off")}<span>Notifications aren't set up on the server yet (the VAPID keys are missing).</span></div>`;
  } else if (Notification.permission === "denied") {
    html = `<div class="warn-note">${ic("bell-off")}<span>Notifications are blocked for this page. Allow them in the browser's site settings (the icon left of the address bar), then come back here.</span></div>`;
  } else {
    const sub = Notification.permission === "granted" ? await currentSub().catch(() => null) : null;
    html = sub
      ? `<p class="push-on">${ic("bell-ring")}<span>On for this device</span></p>
         <div class="btn-row" style="margin-top:8px">
           <button type="button" id="test-notify" class="btn-outline" style="padding:0 16px">${ic("send")}Send a test notification</button>
           <button type="button" id="push-off" class="text-btn">Turn off</button>
         </div>`
      : `<div class="btn-row"><button type="button" id="push-on" class="btn-primary" style="padding:0 18px">${ic("bell-ring")}Turn on notifications</button></div>`;
  }
  box.innerHTML = html + others;
  $("push-on")?.addEventListener("click", enablePush);
  $("push-off")?.addEventListener("click", () => disablePush());
  $("test-notify")?.addEventListener("click", async () => {
    const r = await api("/api/test-notify", { method: "POST", body: "{}" });
    if (r.ok) toast(`Test sent to ${r.data.devices} device${r.data.devices === 1 ? "" : "s"}`);
    else if (r.status === 429) toast(`Wait ${r.data.wait_s} s before sending another`);
    else toast(r.data.error || "Couldn't send it");
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement("textarea");
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  toast("Copied");
}

$("settings-btn").addEventListener("click", () => setView(view === "settings" ? lastView : "settings"));
$("settings-back").addEventListener("click", () => setView(lastView));

// ---------------- actions ----------------
function toast(msg) {
  const t = $("toast");
  t.querySelector("span").textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 2200);
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const err = $("login-error");
  err.hidden = true;
  const r = await api("/api/login", { method: "POST", body: JSON.stringify({ username: String(f.get("username")).trim(), password: f.get("password") }) });
  if (!r.ok) {
    err.querySelector("span").textContent = r.status === 401 ? "That didn't match. Check the details in Readest → Settings → Integrations → KOReader Sync." : (r.data.error || "Sign-in failed.");
    err.hidden = false;
    return;
  }
  start();
});


$("nudge").addEventListener("click", async () => {
  const btn = $("nudge");
  btn.disabled = true;
  const r = await api("/api/nudge", { method: "POST", body: "{}" });
  btn.disabled = false;
  if (r.ok) toast("Nudge sent");
  else if (r.status === 429) toast(`Already nudged · try again in ${Math.ceil(r.data.wait_s / 60)} min`);
  else toast("Couldn't send the nudge");
});

$("daily-toggle").addEventListener("click", () => { dailyTable = !dailyTable; if (state) renderDaily(state); });
document.querySelectorAll("#viewtabs button").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));

$("wish-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await api("/api/wishlist", { method: "POST", body: JSON.stringify({ title: f.get("title"), authors: f.get("authors"), note: f.get("note") }) });
  if (!r.ok) return toast(r.data.error || "Couldn't add it");
  e.target.reset();
  toast("Added to want to read");
  loadLibrary();
  setTimeout(loadLibrary, 3000); // the cover lookup finishes in the background
});

document.addEventListener("visibilitychange", () => { if (!document.hidden && state) refresh(); });
document.addEventListener("scroll", hideTip, { passive: true });

function start() {
  stopTimers();
  refresh();
  timers = [
    setInterval(() => { if (!document.hidden) pollLive(); }, 5000),
    setInterval(() => { if (!document.hidden) { refresh(); if (view === "shelves") loadLibrary(); } }, 60000),
    setInterval(tick, 1000),
  ];
}
start();

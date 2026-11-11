# coread: design brief

**Ask:** redesign the visual layer of **coread**, a small co-reading companion app, in a **warm minimalist** style. The features, information architecture and data stay as they are. This brief covers the look, the feel and the component system.

---

## 1. What coread is

Two people in a long-distance relationship read books "together" while apart: sometimes the same book, often different ones. They both read in an e-reader app (Readest) on their phones, tablets and Windows PCs. Readest quietly syncs their reading position to coread. coread turns that stream into:

- **Presence:** who's reading right now, on which device, which book, how far in.
- **Shared progress:** both progress bars for a book they're both reading, who's ahead, and a spoiler warning when one is far ahead.
- **Reading habits:** minutes per day, streaks, when they read (heatmap), pace, time spent reading at the same moment.
- **Session timelines:** a minute-by-minute view of each reading session.
- **Shelves:** a tiny private Goodreads for two people. Currently reading, want to read, finished (with star ratings and notes), paused.
- **Notifications** (sent as phone push notifications; out of scope for this redesign).

**Users:** exactly two people (in the sample data, "Rohan" and "Queen"). It's private and personal: a shared space, not a social network.

**When it's used:**
- glanced at on a phone in bed or on the commute ("is she reading right now?");
- opened from a notification;
- browsed slowly on a Sunday to look at the week's habits and shelves.

**Feeling:** intimate, calm, bookish, affectionate without being cute. Think a well-loved paperback, a reading lamp, a handwritten margin note. **Not** a fitness tracker, a social feed or a SaaS dashboard.

## 2. Style direction: warm minimalism

| Do | Don't |
|---|---|
| Paper-like warm off-white surfaces, warm near-black dark mode (not blue-grey) | Pure white #fff / pure black, cold greys |
| Plenty of whitespace, few dividers, hairline borders | Heavy cards, drop shadows everywhere, gradients |
| A serif for book titles and headings (editorial, bookish); a quiet humanist sans for UI and numbers | More than two typefaces; condensed or geometric "tech" fonts |
| Muted, earthy accents (ink blue, terracotta, sage, ochre) | Neon, saturated primaries, purple-gradient "AI" look |
| One small consistent line-icon set | Emoji as UI icons (the current build uses emoji; replace them) |
| Gentle motion: a soft pulse on "reading now", short fades | Bouncy, attention-seeking animation |
| Small delights: the moment you're both reading, a finished book, a hidden note | Gamification: badges, confetti, leaderboards |

Optional texture: a very subtle paper grain or soft vignette on the page background is welcome if it stays under ~2 KB as CSS or SVG. No raster images.

## 3. Hard constraints (it must be buildable as-is)

- **Tech:** a static page of plain HTML, one CSS file and vanilla JS. **No framework, no build step, no component library.** Charts are hand-drawn inline SVG. The design must be expressible in plain CSS (custom properties, grid and flexbox).
- **Fonts:** at most **two web fonts** from Google Fonts (one serif, one sans), with a system-font fallback. Numbers use tabular figures.
- **Viewport:** **mobile-first**, 360–430 px wide; it's mostly used as an installed home-screen app on Android. It must also look good on a desktop browser with content max-width ~760 px, centred. No horizontal scrolling at any width.
- **Modes:** **light and dark** are both required and designed together, each as its own palette rather than an automatic inversion. It follows the OS setting.
- **Accessibility:**
  - text contrast WCAG AA;
  - tap targets ≥ 44 px;
  - focus states visible;
  - `prefers-reduced-motion` respected;
  - nothing communicated by colour alone (always paired with a label or icon).

## 4. Colour rules that must survive the restyle

The two people are encoded by **one fixed colour each**, everywhere: avatars, progress bars, chart series, legends and chips. The colour follows the person, not who's signed in. These two colours carry the data, so:

1. **Person 1 and person 2 must stay clearly distinguishable**, including for colour-blind viewers (target ΔE ≥ 8 between the pair under protan, deutan and tritan simulation), **in both light and dark mode**. Each needs ≥ 3:1 contrast against the surface it sits on. A warm pair works well, e.g. *ink blue + terracotta*, or *slate teal + burnt orange*. Two warm hues like terracotta + ochre will fail.
2. **Text never takes a person's colour.** Labels and values stay in ink colours, and a small swatch or the avatar carries the identity.
3. **The heatmap uses one hue, light → dark** (a sequential ramp of 7 steps including an "empty" step). Never a rainbow.
4. **Status colours are reserved and always paired with an icon and label:**
   - *reading now* (a calm green);
   - *spoiler zone* (amber / ochre warning);
   - *error* (muted red).
   They must not be confusable with the two person colours.
5. Deliver every colour as **light + dark tokens** (see §8).

The current build uses blue `#2a78d6` / orange `#eb6834` (dark: `#3987e5` / `#d95926`), validated colour-blind safe. Treat them as the baseline to beat, not to copy.

## 5. Screens and components

The sample content below is realistic; please design with it.

### 5.1 Sign-in
A small centred card: app name, one line of explanation ("Use the username and password from Readest's sync settings"), username and password fields, a primary button, and an inline error line. It's the first impression, so make it feel like opening a book, not logging into a bank.

### 5.2 App shell
- **Top bar (sticky):** small wordmark "coread" with a mark, and on the right **Nudge** (primary: pings the partner, "come read with me") and **Sign out** (quiet).
- **View switch:** a segmented control, **Today | Shelves**, below the bar.
- **Toast:** small pill at the bottom ("Nudge sent", "Saved").
- **Tooltip:** for chart hovers and taps; small, high-contrast.

### 5.3 Today: presence (top of page, two stacked cards, one per person)
Each card has:
- avatar (initial on the person's colour) with a status dot;
- name, plus "(you)" for the signed-in person;
- **status line**, one of:
  - **Reading now** on their phone · page turned 23 s ago (the timer ticks every second; the dot gently pulses);
  - Last read 2 h ago on PC;
  - Hasn't synced yet.
- **book line:** *The Drug Hunters* · 1% · section 5;
- **optional extra device lines**, smaller and muted: "Also open on their PC: *Everything Is Tuberculosis* · 3 min ago".

Long titles wrap; never truncate. Under the cards, when relevant, a **together banner**: "You're both reading right now", or "You read together for 25 min today". This is a highlight moment; make it feel special but quiet.

### 5.4 Today: Books
One card per book with recent activity. Shared books (both reading) come first.
- **Title** (serif) and author.
- **A ✎ rename control** (or "Name this book" when the title is unknown).
- **Per-reader row:** name ("You" or the partner's name), a thin progress bar in the person's colour, and the % on the right.
  - Below it, a muted meta line: "section 4 · 3 h ago · ~15 h left".
- **Gap line:** "You're 6% ahead of Queen" / "Neck and neck". **Or a spoiler warning:** "Spoiler zone: Queen is 20% ahead. Don't let her tell you anything!"
- **Collapsible "Time per section"** shows paired horizontal bars per section (§12, §13 …), one bar per person with the value label at the end ("16m"), a legend, and a "Show as table" disclosure.

### 5.5 Today: Reading habits
- **Comparison table:** a row label and one column per person (headed by swatch + name). Rows:
  - Today 31m · This week 3h 10m · Streak 4 days;
  - Sessions (7 days) 6 · Average session 28m;
  - Time per page (7 days) 48 s (210 pages) · Pace 6.0% / hour;
  - a full-width row: **Together:** 1h 20m this week · 4h 05m in 4 weeks.
- **Chart, "Minutes read per day":** 14 days of grouped bars (2 people), y-axis in minutes, x-axis as weekday labels and "Today". It has a legend, a tooltip per day, and "Show as table".
- **Chart, "When you read" (last 4 weeks):** a 7 × 24 heatmap (Mon–Sun × hours), a tab per person, a "less ▢▢▢▢ more" scale, and a tooltip per cell ("Tue 21:00–22:00 · 34 min").

### 5.6 Today: Sessions
A list of recent sessions from both people.
- **Collapsed row:** colour swatch, name and book title. Underneath, "Today 20:57–21:29 · phone" and a facts line, "33m · 10% → 15% (+5.0%) · 48 s / page · 1 jump".
- **Expanded:**
  - a 4-tile facts grid (Reading time · Pages turned · Typical page · Jumps);
  - **"Where in the book":** a line chart of book % over the session's clock time, with a crosshair and tooltip, and a ring marker on jumps;
  - **"Seconds per page":** thin bars, one per page turn, at their time positions.

### 5.7 Today: Activity
A quiet feed of events with relative times on the right:
- "Queen started a new book: *Everything Is Tuberculosis*";
- "Rohan finished section 3 of *The Drug Hunters*";
- "Queen rated *The Drug Hunters* ★★★★☆";
- "Weekly recap: …".

### 5.8 Shelves
- **Person switch:** "Your shelves | Queen's shelves" (segmented control with swatches).
- **Year line:** "2026: 3 finished · 5 started · 41.5 h read".
- **Sections:** Currently reading · Want to read · Finished · Paused & put down. Each has an empty state ("Nothing on the go right now.").
- **Book entry card:**
  - title (serif) and author;
  - progress bar (reading and paused only);
  - meta line, depending on status:
    - reading: "Started 3 Oct · last read 2 h ago · 4h 10m over 6 sessions";
    - finished: "Finished 20 Oct · 17 days · 9h 40m";
    - paused: "Last read 25 days ago at 43%";
  - **partner chip** when both have the book: "Queen: 33%" or "Queen: finished ★★★★★";
  - **rating:** 5 stars, tappable on your own books and read-only on the partner's;
  - **note:** an italic quote, like a margin note ("Made me cry twice."). On the partner's book, if you haven't finished it yet, it's a **hidden-note state** instead: "Note hidden until you finish this book · tap to read anyway";
  - **owner actions** (small, quiet): Edit note · Mark finished · Put down · Back to reading.
- **Want to read:** an add form (Title, Author (optional), Why? (optional), Add) for your own shelf only. Entries show title, author, the "why" note, "Added 2 Nov", and a remove control (owner only).

## 6. States to design

| Element | States |
|---|---|
| Presence card | reading now (live, pulsing) · away · never synced · with 0 / 1 / 2 extra devices |
| Together banner | both reading now · read together today · hidden |
| Book card | shared and close · shared with spoiler · solo · untitled ("Name this book") · section panel open |
| Session row | collapsed · expanded · expanded with too little data ("Only one position update…") |
| Shelf entry | reading · finished with rating and note · paused · put down · partner's view with hidden note · partner's view revealed |
| Lists | empty states for every section; loading ("Loading…") inside panels |
| Whole page | signed out (login) · first run (no books yet) · light and dark |

## 7. Content and voice

Short, warm and plain. Second person. It may be gently playful in the moments that matter (spoilers, finishing a book, reading together) but never gushy.
- "Spoiler zone: you're 7% ahead. Careful what you say!"
- "Time to talk about the ending."

Use sentence case everywhere. Relative times read like "23 s ago", "2 h ago", "yesterday".

## 8. Deliverables

1. **Mobile screens (390 px), light and dark:** sign-in · Today (full scroll) · Today with one session expanded and one section panel open · Shelves (own) · Shelves (partner view, hidden note) · first-run empty state.
2. **Desktop (1280 px), light:** Today and Shelves.
3. **Design tokens as CSS custom properties,** light and dark, using these names so they drop straight into the existing stylesheet:
   - surfaces: `--page`, `--surface`, `--surface-2`, `--border`;
   - ink: `--ink`, `--ink-2`, `--ink-3`;
   - people: `--series-1`, `--series-2`;
   - status: `--good`, `--warn`, `--warn-bg`, `--error`;
   - heatmap ramp: `--seq-0` … `--seq-6`;
   - also `--radius`, and type tokens (families, sizes, weights, line heights).
4. **Component specs:** spacing, radii, borders and typography for every element in §5, plus chart styling (axis and grid colour, bar radius, line width, marker size, tooltip).
5. **Icon list:** which line icon replaces each current emoji (reading dot, phone / tablet / PC, book, nudge, edit, star, spoiler warning, hidden note, together, activity kinds). Name a free icon set (e.g. Lucide) and give the icon names.

## 9. Out of scope

New features, navigation changes, notification design, a logo beyond a simple wordmark and mark, illustrations or photos, and marketing pages.

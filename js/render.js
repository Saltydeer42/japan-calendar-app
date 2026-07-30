/* ==========================================================================
   render.js — paints the trip sheet from the itinerary document.

   The markup this produces is deliberately identical to the original
   hand-written index.html, so the stylesheet carries over untouched.
   ========================================================================== */

import { state } from "./store.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* ------------------------------------------------------------- escaping -- */

export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Notes carry a little emphasis from the original sheet. Allow that and
 *  nothing else, so a note typed on a phone can never inject markup. */
const ALLOWED = /&lt;(\/?)(strong|em|b|i|br)\s*\/?&gt;/gi;

export function rich(s) {
  return esc(s).replace(ALLOWED, (_, slash, tag) => `<${slash}${tag.toLowerCase()}>`);
}

/* ---------------------------------------------------------------- dates -- */

export function eachDate(start, end) {
  const out = [];
  const d = new Date(start + "T12:00:00");
  const last = new Date(end + "T12:00:00");
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

export function dayNumber(iso) {
  return String(Number(iso.slice(8, 10)));
}

export function weekday(iso) {
  return WEEKDAYS[new Date(iso + "T12:00:00").getDay()];
}

export function monthName(iso) {
  return MONTHS[Number(iso.slice(5, 7)) - 1];
}

/** Where you are that day. Later ranges win, which is how the Nara and Fuji
 *  day trips override the leg they sit inside. */
export function cityFor(date) {
  let name = "";
  for (const c of state.data.cities || []) {
    if (date >= c.start && date <= c.end) name = c.name;
  }
  return name;
}

export function eventsOn(date) {
  return state.data.events
    .filter((e) => e.date === date)
    .sort((a, b) => a.sort - b.sort);
}

/* --------------------------------------------------------------- places -- */
// Saved spots are not events: nothing is booked, nothing has a time, and they
// never take part in drag or in the ICS. They hang off a day, or off a bucket.

export function allPlaces() {
  return state.data.places?.items || [];
}

export function placesOn(date) {
  return allPlaces().filter((p) => p.date === date);
}

export function placesInBucket(key) {
  return allPlaces().filter((p) => !p.date && p.bucket === key);
}

export function mapsQuery(p) {
  return p.query || [p.name, p.city].filter(Boolean).join(", ");
}

export function mapsUrl(p) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery(p))}`;
}

/* ---------------------------------------------------------------- parts -- */

function pillHtml(p) {
  const style = p.style && p.style !== "plain" ? ` ${p.style}` : "";
  return `<span class="pill${style}">${esc(p.text)}</span>`;
}

export function entryHtml(e) {
  const tent = e.status === "tentative" ? " tent" : "";
  const place = e.place
    ? ` role="button" tabindex="0" data-place="${esc(e.place)}" data-label="${esc(e.label || e.title)}"`
    : ' role="button" tabindex="0"';
  const pills = (e.pills || []).map(pillHtml).join(" ");
  const note = e.note ? `<div class="note">${rich(e.note)}</div>` : "";
  const time = e.time
    ? `<div class="t${e.timeHard ? " hard" : ""}">${esc(e.time)}</div>`
    : "";

  return `<div${place} class="entry e-${esc(e.cat)}${tent}" data-c="${esc(e.cat)}" data-s="${esc(e.status)}" data-id="${esc(e.id)}">
  <div class="meta"><div class="cat">${esc(e.kicker)}</div>${time}</div>
  <div><div class="title">${esc(e.title)}${pills ? " " + pills : ""}</div>${note}</div>
</div>`;
}

/** One line on the day panel standing in for every saved spot on it. Tapping it
 *  opens the list; keeping them off the day itself is the point. */
function savedRowHtml(date) {
  const list = placesOn(date);
  if (!list.length) return "";

  const areas = [...new Set(list.map((p) => p.area).filter(Boolean))];
  const sub = areas.slice(0, 3).join(" · ") + (areas.length > 3 ? " …" : "");

  return `<button class="savedrow" data-date="${date}"
  aria-label="Saved spots for this day, ${list.length}">
  <span class="sv-n">${list.length}</span>
  <span class="sv-main"><span class="sv-t">Saved spots</span><span class="sv-s">${esc(sub)}</span></span>
</button>`;
}

function dayHtml(date, i, all) {
  const list = eventsOn(date);
  const inner = list.length
    ? list.map(entryHtml).join("")
    : `<div class="emptyday">Nothing here yet</div>`;
  const city = cityFor(date);

  return `<section class="day" data-date="${date}" data-i="${i}"
  role="group" aria-roledescription="day" aria-label="${weekday(date)} ${monthName(date)} ${dayNumber(date)}${city ? ", " + esc(city) : ""}">
  <header class="dayhead">
    <div class="dh-when">
      <div class="n">${dayNumber(date)}</div>
      <div class="d">${weekday(date)} · ${monthName(date)}</div>
    </div>
    <div class="dh-where">
      <div class="dh-city">${esc(city)}</div>
      <div class="dh-pos">Day ${i + 1} of ${all.length}</div>
    </div>
  </header>
  <div class="entries${list.length ? "" : " empty"}" data-date="${date}">${inner}</div>
  ${savedRowHtml(date)}
</section>`;
}

/* --------------------------------------------------------------- render -- */

export function renderDays() {
  const d = state.data;
  const dates = eachDate(d.trip.start, d.trip.end);
  document.getElementById("days").innerHTML = dates.map(dayHtml).join("");
  renderDots(dates);
}

function renderDots(dates) {
  const dots = document.getElementById("daydots");
  if (!dots) return;
  dots.innerHTML = dates
    .map(
      (date, i) =>
        `<button class="dot" data-i="${i}" data-date="${date}" role="tab"
      aria-label="${weekday(date)} ${monthName(date)} ${dayNumber(date)}"></button>`
    )
    .join("");
}

/* -------------------------------------------------------- saved spot list - */

function placeCard(p) {
  const flags = [];
  if (p.closed === "temporarily") flags.push(`<span class="pill pend">Temporarily closed</span>`);
  if (p.closed === "permanently") flags.push(`<span class="pill shut">Do not go, closed for good</span>`);
  if (p.tentative) flags.push(`<span class="pill">Unconfirmed</span>`);

  const where = [p.area, p.city].filter(Boolean).join(" · ");
  const note = p.note ? `<p class="pc-note">${rich(p.note)}</p>` : "";

  return `<article class="pcard e-${esc(p.cat)}">
  <div class="pc-head">
    <h3>${esc(p.name)}</h3>
    <span class="pc-kind">${esc(p.kind)}</span>
  </div>
  <p class="pc-where">${esc(where)}</p>
  ${flags.length ? `<p class="pc-flags">${flags.join(" ")}</p>` : ""}
  ${note}
  <a class="pc-map" href="${esc(mapsUrl(p))}" target="_blank" rel="noopener">Open in Google Maps</a>
</article>`;
}

/** A day's spots read better in a few labelled runs than as one flat list.
 *  Fixed order, so every day reads the same way; anything that fits none of
 *  these, an inn or a station, falls to the end. */
const PLACE_GROUPS = [
  { heading: "See", cats: ["see"] },
  { heading: "Coffee and food", cats: ["drink", "eat"] },
  { heading: "Shops", cats: ["shop"] },
];

function groupPlaces(list) {
  const groups = PLACE_GROUPS
    .map((g) => ({ heading: g.heading, items: list.filter((p) => g.cats.includes(p.cat)) }))
    .filter((g) => g.items.length);
  const rest = list.filter((p) => !PLACE_GROUPS.some((g) => g.cats.includes(p.cat)));
  if (rest.length) groups.push({ heading: "Also saved", items: rest });
  return groups;
}

/** The saved-spots page for one day. Returns false if there is nothing on it. */
export function renderPlacesPage(date) {
  const list = placesOn(date);
  if (!list.length) return false;

  // One heading over the whole list would say nothing, so a day that is all
  // temples or all cafes stays flat.
  const groups = groupPlaces(list);
  const cards =
    groups.length > 1
      ? groups
          .map((g) => `<h2 class="pl-grp">${esc(g.heading)}</h2>` + g.items.map(placeCard).join(""))
          .join("")
      : list.map(placeCard).join("");

  const city = cityFor(date);
  document.getElementById("pltitle").textContent = "Saved spots";
  document.getElementById("plsub").textContent =
    `${weekday(date)} ${monthName(date)} ${dayNumber(date)}${city ? " · " + city : ""}`;
  document.getElementById("plbody").innerHTML =
    `<p class="pl-lede">${esc(state.data.places?.sub || "")}</p>` + cards;
  return true;
}

/** Everything saved that never landed on a day, with the reason why. */
function renderExtra() {
  const el = document.getElementById("extra");
  const p = state.data.places;
  if (!el) return;
  const buckets = (p?.buckets || []).filter((b) => placesInBucket(b.key).length);
  if (!buckets.length) return el.classList.add("hidden");
  el.classList.remove("hidden");

  el.innerHTML =
    `<h2>Saved, but not on a day</h2>
     <p class="sub">The rest of the list, and why each one is sitting here.</p>` +
    buckets
      .map((b) => {
        const rows = placesInBucket(b.key)
          .map((place) => {
            const where = [place.area, place.city].filter(Boolean).join(" · ");
            const why = place.note ? `${where}. ${place.note}` : where;
            return `<div class="row"><span class="st ${esc(b.status)}">${esc(b.label)}</span><div>
        <div class="what"><a href="${esc(mapsUrl(place))}" target="_blank" rel="noopener">${esc(place.name)}</a></div>
        <div class="why">${rich(why)}</div></div></div>`;
          })
          .join("");
        return `<div class="grp"><h3>${esc(b.heading)}</h3>${rows}</div>`;
      })
      .join("");
}

export function renderStats() {
  const ev = state.data.events;
  const count = (s) => ev.filter((e) => e.status === s).length;

  // "Open" means outstanding bookings, which are tracked on the board. Counting
  // the to-book entries as well would double up, since an open item generally
  // appears in both places. The original sheet had this typed in by hand and it
  // had drifted; counting it keeps it honest.
  const open = (state.data.board?.groups || []).reduce(
    (n, g) => n + g.rows.filter((r) => r.status !== "done").length,
    0
  );

  document.getElementById("stats").innerHTML = `
    <div class="stat"><b>${count("locked")}</b><span>Locked</span></div>
    <div class="stat open"><b>${open}</b><span>Open</span></div>
    <div class="stat"><b>${count("tentative")}</b><span>Tentative</span></div>`;
}

function renderHeader() {
  const t = state.data.trip;
  document.getElementById("tripTitle").textContent = t.title;
  document.getElementById("tripDates").textContent = t.dates;
  document.title = `${t.title} · ${t.dates}`;
}

function renderNotice() {
  const el = document.getElementById("notice");
  const n = state.data.notice;
  if (!n || !n.title) return el.classList.add("hidden");
  el.classList.remove("hidden");
  el.innerHTML =
    `<h2>${esc(n.title)}</h2>` + (n.body || []).map((p) => `<p>${rich(p)}</p>`).join("");
}

function renderLegs() {
  document.getElementById("legs").innerHTML = (state.data.legs || [])
    .map(
      (l) => `<div class="leg card"><div class="dot" style="background:${esc(l.color)}"></div>
      <div class="nm">${esc(l.name)}</div><div class="mt">${esc(l.meta)}</div></div>`
    )
    .join("");
}

function renderBoard() {
  const el = document.getElementById("board");
  const b = state.data.board;
  if (!b || !b.groups || !b.groups.length) return el.classList.add("hidden");
  el.classList.remove("hidden");
  el.innerHTML =
    `<h2>${esc(b.title)}</h2><p class="sub">${esc(b.sub)}</p>` +
    b.groups
      .map(
        (g) => `<div class="grp"><h3>${esc(g.heading)}</h3>` +
          g.rows
            .map(
              (r) => `<div class="row"><span class="st ${esc(r.status)}">${esc(r.label)}</span><div>
        <div class="what">${esc(r.what)}</div>
        <div class="why">${rich(r.why)}</div></div></div>`
            )
            .join("") +
          `</div>`
      )
      .join("");
}

function renderFoot() {
  const el = document.getElementById("foot");
  const r = state.data.rules;
  if (!r || !r.items || !r.items.length) return el.classList.add("hidden");
  el.classList.remove("hidden");
  el.innerHTML =
    `<h2>${esc(r.title)}</h2><ul>` +
    r.items.map((i) => `<li>${rich(i)}</li>`).join("") +
    `</ul>`;
}

/** Full repaint. Cheap enough at this size, and keeps state handling simple. */
export function renderAll() {
  renderHeader();
  renderStats();
  renderNotice();
  renderLegs();
  renderDays();
  renderBoard();
  renderExtra();
  renderFoot();
}

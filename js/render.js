/* ==========================================================================
   render.js — paints the trip sheet from the itinerary document.

   The markup this produces is deliberately identical to the original
   hand-written index.html, so the stylesheet carries over untouched.
   ========================================================================== */

import { state } from "./store.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

export function eventsOn(date) {
  return state.data.events
    .filter((e) => e.date === date)
    .sort((a, b) => a.sort - b.sort);
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

function dayHtml(date) {
  const list = eventsOn(date);
  const inner = list.length
    ? list.map(entryHtml).join("")
    : `<div class="emptyday">Nothing here yet</div>`;

  return `<div class="day" data-date="${date}">
  <div class="daymark"><div class="n">${dayNumber(date)}</div><div class="d">${weekday(date)}</div></div>
  <div class="entries${list.length ? "" : " empty"}" data-date="${date}">${inner}</div>
</div>`;
}

/* --------------------------------------------------------------- render -- */

export function renderDays() {
  const d = state.data;
  document.getElementById("days").innerHTML = eachDate(d.trip.start, d.trip.end)
    .map(dayHtml)
    .join("");
}

export function renderStats() {
  const ev = state.data.events;
  const count = (s) => ev.filter((e) => e.status === s).length;

  // "Open" means outstanding bookings, which live on the board rather than in
  // the day list. The original sheet had this typed in by hand and it had
  // drifted; counting it keeps it honest.
  const open =
    (state.data.board?.groups || []).reduce(
      (n, g) => n + g.rows.filter((r) => r.status !== "done").length,
      0
    ) + count("todo");

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
  renderFoot();
}

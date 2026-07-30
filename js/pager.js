/* ==========================================================================
   pager.js — one day per screen, swiped left and right.

   The trip is seventeen days and a phone shows about one of them at a time, so
   the list scrolls forever and you lose your place. Here each day is a panel
   the width of the card, and the whole strip is moved with a transform.

   Native scroll-snap would be less code, but it fights two things this app
   already does: press-and-hold drag needs the browser to stop panning
   mid-gesture, and the card has to take the height of the day you are on
   rather than the tallest day in the trip. Both are simple with a transform
   and awkward without.
   ========================================================================== */

import { state } from "./store.js";
import { eachDate } from "./render.js";
import { haptic } from "./haptics.js";

const el = (id) => document.getElementById(id);

const SWIPE_FRACTION = 0.18;   // of the panel width, to count as a page turn
const FLICK = 0.4;             // px per ms, a fast short swipe still turns
const LOCK = 8;                // px before the gesture commits to an axis

let pager = null;
let track = null;
let dates = [];
let index = 0;
let opts = {};
let gesture = null;
let lastNudge = 0;

/* --------------------------------------------------------------- helpers - */

export function currentDate() {
  return dates[index] || "";
}

function width() {
  return pager ? pager.clientWidth : 0;
}

function panels() {
  return [...track.children];
}

function heightOf(i) {
  const p = panels()[i];
  return p ? p.offsetHeight : 0;
}

function place(offset, animate) {
  track.classList.toggle("animate", !!animate);
  track.style.transform = `translate3d(${-index * width() + offset}px, 0, 0)`;
}

/** The card takes the height of the day you are on. During a swipe it takes
 *  the taller of the two in play, so neither gets clipped on the way past. */
function setHeight(px, animate) {
  pager.classList.toggle("animate", !!animate);
  pager.style.height = `${px}px`;
}

function paintDots() {
  const dots = el("daydots");
  if (!dots) return;
  [...dots.children].forEach((d, i) => {
    d.classList.toggle("on", i === index);
    d.setAttribute("aria-selected", String(i === index));
  });
  const prev = el("dayprev");
  const next = el("daynext");
  if (prev) prev.disabled = index === 0;
  if (next) next.disabled = index === dates.length - 1;
}

function writeHash() {
  const want = `#day=${currentDate()}`;
  if (location.hash !== want) history.replaceState(null, "", want);
}

/* ----------------------------------------------------------------- moves - */

/** Days are taller than the screen, so turning the page while halfway down one
 *  would drop you halfway down the next. Put the top of the day back on screen,
 *  but only when it has scrolled off. */
function reveal() {
  const nav = el("daynav");
  const bar = document.querySelector(".bar");
  const barH = bar ? bar.getBoundingClientRect().height : 0;
  const top = nav.getBoundingClientRect().top;
  if (top >= barH) return;
  window.scrollTo({ top: window.scrollY + top - barH - 6, behavior: "smooth" });
}

export function goTo(i, { animate = true, silent = false, hash = true, scroll = true } = {}) {
  const next = Math.max(0, Math.min(dates.length - 1, i));
  const moved = next !== index;
  index = next;
  place(0, animate);
  setHeight(heightOf(index), animate);
  paintDots();
  if (hash) writeHash();
  if (moved && !silent) {
    haptic("light");
    if (scroll) reveal();
    if (opts.onChange) opts.onChange(currentDate());
  }
}

export function goToDate(date, options) {
  const i = dates.indexOf(date);
  if (i >= 0) goTo(i, options);
}

export function step(dir, options) {
  goTo(index + dir, options);
}

/** Called while an entry is being dragged and the finger is at the edge of the
 *  screen: turns the page so an entry can be dropped on another day. */
export function nudge(dir) {
  const now = Date.now();
  if (now - lastNudge < 520) return;
  const next = index + dir;
  if (next < 0 || next > dates.length - 1) return;
  lastNudge = now;
  goTo(next, { scroll: false });   // the page is already moving under a finger
}

/** After a repaint the panels are new nodes, so the transform and the height
 *  have to be put back on them. */
export function refresh() {
  if (!pager) return;
  const date = dates[index];
  dates = eachDate(state.data.trip.start, state.data.trip.end);
  const i = dates.indexOf(date);
  index = i >= 0 ? Math.max(0, Math.min(dates.length - 1, i)) : index;
  goTo(index, { animate: false, silent: true });
}

/* --------------------------------------------------------------- gesture - */

function onStart(ev) {
  if (ev.touches.length !== 1 || opts.blocked?.()) return;
  const t = ev.touches[0];
  gesture = { x: t.clientX, y: t.clientY, dx: 0, axis: null, t: Date.now() };
}

function onMove(ev) {
  if (!gesture || opts.blocked?.()) return (gesture = null);
  const t = ev.touches[0];
  const dx = t.clientX - gesture.x;
  const dy = t.clientY - gesture.y;

  if (!gesture.axis) {
    if (Math.abs(dx) < LOCK && Math.abs(dy) < LOCK) return;
    gesture.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    if (gesture.axis === "x") {
      // Neither of the two panels in play should be clipped on the way past.
      setHeight(Math.max(heightOf(index), heightOf(index + (dx < 0 ? 1 : -1))), false);
    }
  }
  if (gesture.axis !== "x") return;

  ev.preventDefault();
  const atEnd = (dx > 0 && index === 0) || (dx < 0 && index === dates.length - 1);
  gesture.dx = atEnd ? dx * 0.3 : dx;   // rubber band at the two ends
  place(gesture.dx, false);
}

function onEnd() {
  if (!gesture) return;
  const { dx, axis, t } = gesture;
  gesture = null;
  if (axis !== "x") return;

  const speed = Math.abs(dx) / Math.max(1, Date.now() - t);
  const far = Math.abs(dx) > width() * SWIPE_FRACTION || speed > FLICK;
  goTo(far ? index - Math.sign(dx) : index);
}

/* ------------------------------------------------------------------ init - */

export function initPager(options = {}) {
  opts = options;
  pager = el("pager");
  track = el("days");
  dates = eachDate(state.data.trip.start, state.data.trip.end);

  const wanted = (location.hash.match(/day=(\d{4}-\d{2}-\d{2})/) || [])[1];
  const at = dates.indexOf(wanted);
  goTo(at >= 0 ? at : 0, { animate: false, silent: true });
  // The first paint must not animate the height up from zero.
  requestAnimationFrame(() => goTo(index, { animate: false, silent: true }));

  pager.addEventListener("touchstart", onStart, { passive: true });
  pager.addEventListener("touchmove", onMove, { passive: false });
  pager.addEventListener("touchend", onEnd, { passive: true });
  pager.addEventListener("touchcancel", onEnd, { passive: true });

  el("dayprev").addEventListener("click", () => step(-1));
  el("daynext").addEventListener("click", () => step(1));
  el("daydots").addEventListener("click", (ev) => {
    const dot = ev.target.closest(".dot");
    if (dot) goTo(Number(dot.dataset.i));
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    if (opts.blocked?.() || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const tag = (ev.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    ev.preventDefault();
    step(ev.key === "ArrowRight" ? 1 : -1);
  });

  window.addEventListener("resize", () => goTo(index, { animate: false, silent: true }));

  window.addEventListener("hashchange", () => {
    const date = (location.hash.match(/day=(\d{4}-\d{2}-\d{2})/) || [])[1];
    if (date && date !== currentDate()) goToDate(date, { animate: false });
  });
}

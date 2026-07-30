/* ==========================================================================
   drag.js — press and hold an entry, then drag it anywhere in the trip.

   Touch makes this fiddly: the same finger-down starts either a scroll, a tap
   or a drag, and we only know which after the fact. So a hold timer decides,
   and any real movement before it fires means the user meant to scroll.

   Once a drag is live we must stop Safari scrolling the page underneath. The
   only thing that reliably does that mid-gesture on iOS is preventDefault on a
   non-passive touchmove, which is why that listener exists.
   ========================================================================== */

import { moveEvent } from "./store.js";
import { eventsOn } from "./render.js";

const HOLD_MS = 380;      // long enough not to fire while scrolling
const SLOP = 10;          // px of movement that cancels the hold
const EDGE = 96;          // autoscroll zone at top and bottom
const SIDE = 44;          // page-turn zone at left and right
const SPEED = 14;

let hold = null;          // pending hold timer
let drag = null;          // live drag
let suppressClick = 0;    // ignore the click that follows a drop
let onEdge = null;        // turns the day page when held at the side

export function isDragging() {
  return !!drag;
}

export function swallowedClick() {
  return Date.now() < suppressClick;
}

/* ------------------------------------------------------------------------ */

export function initDrag(root, onMoved, options = {}) {
  onEdge = options.onEdge || null;

  root.addEventListener("pointerdown", (ev) => {
    if (ev.button != null && ev.button !== 0) return;
    const entry = ev.target.closest(".entry");
    if (!entry || !entry.dataset.id) return;

    const start = { x: ev.clientX, y: ev.clientY };
    cancelHold();

    hold = {
      entry,
      start,
      timer: setTimeout(() => {
        hold = null;
        begin(entry, start, onMoved);
      }, HOLD_MS),
    };

    const abort = (e) => {
      if (hold && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP) {
        cancelHold();
      }
    };
    const done = () => {
      cancelHold();
      document.removeEventListener("pointermove", abort);
      document.removeEventListener("pointerup", done);
      document.removeEventListener("pointercancel", done);
    };
    document.addEventListener("pointermove", abort);
    document.addEventListener("pointerup", done);
    document.addEventListener("pointercancel", done);
  });

  // Non-passive, so preventDefault actually stops the page scrolling.
  document.addEventListener(
    "touchmove",
    (ev) => {
      if (drag) ev.preventDefault();
    },
    { passive: false }
  );
}

function cancelHold() {
  if (hold) clearTimeout(hold.timer);
  hold = null;
}

/* -------------------------------------------------------------- lift off - */

function begin(entry, start, onMoved) {
  const rect = entry.getBoundingClientRect();

  const ghost = entry.cloneNode(true);
  ghost.classList.add("dragghost");
  ghost.classList.remove("source");
  ghost.style.width = `${rect.width}px`;
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  document.body.appendChild(ghost);

  const line = document.createElement("div");
  line.className = "dropline";

  entry.classList.add("source");
  document.body.classList.add("dragging");

  drag = {
    id: entry.dataset.id,
    entry,
    ghost,
    line,
    startX: start.x,
    startY: start.y,
    x: start.x,
    y: start.y,
    target: null,
    onMoved,
    raf: 0,
  };

  paint();
  hit(start.x, start.y);
  drag.raf = requestAnimationFrame(tick);

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancel);
}

// The ghost is pinned at the entry's original position, then offset by however
// far the finger has travelled since. It is position:fixed, so page scrolling
// during a drag does not shift it out from under the finger.
function paint() {
  if (!drag) return;
  const dx = drag.x - drag.startX;
  const dy = drag.y - drag.startY;
  drag.ghost.style.transform = `translate(${dx}px, ${dy}px) scale(1.03)`;
}

function onMove(ev) {
  if (!drag) return;
  drag.x = ev.clientX;
  drag.y = ev.clientY;
  paint();
  hit(ev.clientX, ev.clientY);
}

/* ------------------------------------------------------------- hit test -- */

function hit(x, y) {
  if (!drag) return;

  drag.ghost.style.visibility = "hidden";
  const under = document.elementFromPoint(x, y);
  drag.ghost.style.visibility = "";
  if (!under) return;

  let box = under.closest(".entries");
  if (!box) {
    const day = under.closest(".day");
    box = day ? day.querySelector(".entries") : null;
  }
  if (!box || box.closest(".day").classList.contains("hidden")) return;

  const siblings = [...box.querySelectorAll(".entry")].filter(
    (el) => el !== drag.entry && !el.classList.contains("hidden")
  );

  let anchor = null;
  for (const el of siblings) {
    const r = el.getBoundingClientRect();
    if (y < r.top + r.height / 2) {
      anchor = el;
      break;
    }
  }

  const empty = box.querySelector(".emptyday");
  if (empty) empty.remove();

  if (anchor) box.insertBefore(drag.line, anchor);
  else box.appendChild(drag.line);

  document.querySelectorAll(".day.droptarget").forEach((d) =>
    d.classList.remove("droptarget")
  );
  box.closest(".day").classList.add("droptarget");

  drag.target = { date: box.dataset.date, anchorId: anchor ? anchor.dataset.id : null };
}

/* ------------------------------------------------------------ autoscroll - */

function tick() {
  if (!drag) return;
  const h = window.innerHeight;
  let dy = 0;
  if (drag.y < EDGE) dy = -SPEED * (1 - drag.y / EDGE);
  else if (drag.y > h - EDGE) dy = SPEED * (1 - (h - drag.y) / EDGE);

  if (dy) {
    window.scrollBy(0, dy);
    hit(drag.x, drag.y);
  }

  // Held against a side, the day underneath turns, which is the only way to
  // reach another day now that they are panels rather than a list.
  if (onEdge) {
    const w = window.innerWidth;
    if (drag.x < SIDE) onEdge(-1);
    else if (drag.x > w - SIDE) onEdge(1);
  }

  drag.raf = requestAnimationFrame(tick);
}

/* ------------------------------------------------------------------ drop - */

function onUp() {
  if (!drag) return;
  const { id, target, onMoved } = drag;
  finish();

  if (target) {
    const list = eventsOn(target.date).filter((e) => e.id !== id);
    const at = target.anchorId
      ? list.findIndex((e) => e.id === target.anchorId)
      : list.length;
    const idx = at < 0 ? list.length : at;
    moveEvent(id, target.date, list[idx - 1] || null, list[idx] || null);
  }

  suppressClick = Date.now() + 350;
  if (onMoved) onMoved();
}

function onCancel() {
  if (!drag) return;
  const onMoved = drag.onMoved;
  finish();
  suppressClick = Date.now() + 350;
  if (onMoved) onMoved();
}

function finish() {
  if (!drag) return;
  cancelAnimationFrame(drag.raf);
  drag.ghost.remove();
  drag.line.remove();
  drag.entry.classList.remove("source");
  document.body.classList.remove("dragging");
  document.querySelectorAll(".day.droptarget").forEach((d) =>
    d.classList.remove("droptarget")
  );
  document.removeEventListener("pointermove", onMove);
  document.removeEventListener("pointerup", onUp);
  document.removeEventListener("pointercancel", onCancel);
  drag = null;
}

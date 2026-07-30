/* ==========================================================================
   places.js — Raquel's Map.

   A day panel shows one row for however many spots are saved on it, and this
   is what that row opens: the list itself, on its own screen, so a day with
   six cafes on it does not read as a day with six appointments. The rows are
   the day's own entry rows, and tapping one opens the same place sheet.

   Nothing here writes. These are candidates, not plans.
   ========================================================================== */

import { renderPlacesPage } from "./render.js";
import { goToDate } from "./pager.js";
import { haptic } from "./haptics.js";

const el = (id) => document.getElementById(id);

let open = false;
let pushed = false;
let lastFocus = null;

export function placesOpen() {
  return open;
}

export function openPlaces(date, { push = true } = {}) {
  if (open || !renderPlacesPage(date)) return;

  lastFocus = document.activeElement;
  open = true;
  document.body.classList.add("placeson");
  el("places").classList.add("on");
  el("plbody").scrollTop = 0;
  el("plback").focus();
  haptic("light");

  // A pushed state means the phone's back gesture closes the page, which is
  // what anyone will try first.
  if (push) history.pushState({ places: date }, "", `#day=${date}&places=1`);
  pushed = true;
}

export function closePlaces({ fromHistory = false } = {}) {
  if (!open) return;
  open = false;
  document.body.classList.remove("placeson");
  el("places").classList.remove("on");
  if (lastFocus && lastFocus.focus) lastFocus.focus();

  if (pushed && !fromHistory) history.back();
  pushed = false;
}

export function initPlaces({ onSpot } = {}) {
  el("plback").addEventListener("click", () => closePlaces());

  // The row lives on the day panel, which is repainted, so listen up on the
  // pager rather than on the row itself.
  el("pager").addEventListener("click", (ev) => {
    const row = ev.target.closest(".savedrow");
    if (row) openPlaces(row.dataset.date);
  });

  // A spot on the page behaves like an entry on the day: tap opens the sheet.
  el("plbody").addEventListener("click", (ev) => {
    const entry = ev.target.closest(".entry");
    if (entry && entry.dataset.id && onSpot) onSpot(entry);
  });
  el("plbody").addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const entry = ev.target.closest(".entry");
    if (entry && entry.dataset.id && onSpot) {
      ev.preventDefault();
      onSpot(entry);
    }
  });

  window.addEventListener("popstate", (ev) => {
    const date = ev.state?.places;
    if (date) {
      openPlaces(date, { push: false });
    } else if (open) {
      closePlaces({ fromHistory: true });
    }
  });

  document.addEventListener("keydown", (ev) => {
    // The place sheet opens on top of this page and takes Escape first.
    if (ev.key !== "Escape" || !open) return;
    if (el("mapscrim").classList.contains("on")) return;
    closePlaces();
  });

  // Landing straight on a saved-spots link.
  const m = location.hash.match(/day=(\d{4}-\d{2}-\d{2}).*places=1/);
  if (m) {
    goToDate(m[1], { animate: false, silent: true });
    openPlaces(m[1]);
  }
}

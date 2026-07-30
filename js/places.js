/* ==========================================================================
   places.js — the saved-spots page.

   A day panel shows one row for however many spots are saved on it, and this
   is what that row opens: the list itself, on its own screen, so a day with
   six cafes on it does not read as a day with six appointments.

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

export function initPlaces() {
  el("plback").addEventListener("click", () => closePlaces());

  // The row lives on the day panel, which is repainted, so listen up on the
  // pager rather than on the row itself.
  el("pager").addEventListener("click", (ev) => {
    const row = ev.target.closest(".savedrow");
    if (row) openPlaces(row.dataset.date);
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
    if (ev.key === "Escape" && open) closePlaces();
  });

  // Landing straight on a saved-spots link.
  const m = location.hash.match(/day=(\d{4}-\d{2}-\d{2}).*places=1/);
  if (m) {
    goToDate(m[1], { animate: false, silent: true });
    openPlaces(m[1]);
  }
}

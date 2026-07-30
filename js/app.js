/* ==========================================================================
   app.js — boot, filters, the place sheet, and everything wired together.
   ========================================================================== */

import { SHELL_VERSION } from "./config.js";
import {
  state,
  init,
  pull,
  subscribe,
  getToken,
  setToken,
  clearToken,
  verifyToken,
  LOCAL,
  DEMO,
} from "./store.js";
import {
  renderAll,
  renderDays,
  renderStats,
  allPlaces,
  mapsQuery,
  setSectionOpen,
} from "./render.js";
import { initDrag, swallowedClick, isDragging } from "./drag.js";
import { initPager, refresh as refreshPager, nudge as nudgeDay } from "./pager.js";
import { initPlaces, placesOpen } from "./places.js";
import { initEditor, openEditor, editorOpen } from "./editor.js";
import { initChat, lockViewport, unlockViewport, revealChat } from "./chat.js";
import { haptic } from "./haptics.js";

const el = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- toast -- */

let toastTimer = null;

function toast(message, bad = false) {
  const t = el("toast");
  t.textContent = message;
  t.classList.toggle("bad", !!bad);
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 2400);
}

/* --------------------------------------------------------------- filter -- */

let filter = "all";

function matches(entry, f) {
  if (f === "all") return true;
  if (f === "tentative") return entry.dataset.s === "tentative";
  if (f === "locked") return entry.dataset.s === "locked";
  return entry.dataset.c === f;
}

function applyFilter(f) {
  filter = f;
  // Scoped to the calendar: the rows on Raquel's Map wear the same class, and
  // filtering a page you opened deliberately would only empty it.
  document.querySelectorAll("#days .entry").forEach((e) =>
    e.classList.toggle("hidden", !matches(e, f))
  );
  // A day is a whole panel now, so it is never removed from the strip: taking
  // days out from under a swipe would lose your place in the trip. An empty
  // day says so instead.
  document.querySelectorAll(".day").forEach((d) => {
    const shown = d.querySelectorAll(".entry:not(.hidden)").length;
    d.querySelector(".entries").classList.toggle("nomatch", f !== "all" && shown === 0);
  });
  document.querySelectorAll(".fbtn").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.f === f))
  );
  refreshPager();
}

/* ----------------------------------------------------------- place sheet - */

const sheet = {
  scrim: el("mapscrim"),
  name: el("mapname"),
  addr: el("mapaddr"),
  apple: el("actapple"),
  google: el("actgoogle"),
  copyTxt: el("copytext"),
};

let sheetPlace = "";
let sheetEventId = null;
let lastFocus = null;

/** The one sheet, whether what you tapped was an event or a saved spot. */
function paintSheet({ name, address, editable }) {
  sheetPlace = address || "";

  sheet.name.textContent = name;
  sheet.addr.textContent = address || "No address on this one";

  const hasPlace = !!address;
  const q = encodeURIComponent(address || "");
  sheet.apple.href = `https://maps.apple.com/?q=${q}`;
  sheet.google.href = `https://www.google.com/maps/search/?api=1&query=${q}`;
  sheet.apple.classList.toggle("hidden", !hasPlace);
  sheet.google.classList.toggle("hidden", !hasPlace);
  el("actcopy").classList.toggle("hidden", !hasPlace);
  el("actedit").classList.toggle("hidden", !editable);
  sheet.copyTxt.textContent = "Copy address";

  lastFocus = document.activeElement;
  sheet.scrim.classList.add("on");
  (hasPlace ? sheet.apple : el("actedit")).focus();
}

function openSheet(entry) {
  const id = entry.dataset.id;
  const event = state.data.events.find((e) => e.id === id);
  if (!event) return;

  sheetEventId = id;
  paintSheet({
    name: event.label || event.title,
    address: event.place || "",
    editable: true,
  });
}

/** Same tap, same sheet, minus the editing: nothing on Raquel's Map is ours to
 *  change. */
function openSpotSheet(entry) {
  const spot = allPlaces().find((p) => p.id === entry.dataset.id);
  if (!spot) return;

  sheetEventId = null;
  paintSheet({ name: spot.name, address: mapsQuery(spot), editable: false });
}

function closeSheet() {
  sheet.scrim.classList.remove("on");
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}

function initSheet() {
  el("actcopy").addEventListener("click", () => {
    const done = () => (sheet.copyTxt.textContent = "Copied");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(sheetPlace).then(done, done);
    } else {
      const t = document.createElement("textarea");
      t.value = sheetPlace;
      document.body.appendChild(t);
      t.select();
      try {
        document.execCommand("copy");
      } catch (e) {
        /* nothing sensible to do */
      }
      document.body.removeChild(t);
      done();
    }
  });

  el("actedit").addEventListener("click", () => {
    const event = state.data.events.find((e) => e.id === sheetEventId);
    closeSheet();
    if (event) openEditor(event, repaint);
  });

  el("actcancel").addEventListener("click", closeSheet);
  sheet.scrim.addEventListener("click", (ev) => {
    if (ev.target === sheet.scrim) closeSheet();
  });
  sheet.apple.addEventListener("click", closeSheet);
  sheet.google.addEventListener("click", closeSheet);

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && sheet.scrim.classList.contains("on")) closeSheet();
  });
}

/* ------------------------------------------------------------- sections -- */
// The panels under the calendar open and close on their heading, and remember
// which way you left them. They are painted by render.js; this is the tapping.

function initSections() {
  const toggle = (head) => {
    const sec = head.closest(".sec");
    if (!sec) return;
    const open = sec.classList.contains("collapsed");
    sec.classList.toggle("collapsed", !open);
    head.setAttribute("aria-expanded", String(open));
    setSectionOpen(head.dataset.sec, open);
    haptic("light");
  };

  document.addEventListener("click", (ev) => {
    const head = ev.target.closest(".sechead");
    if (head) toggle(head);
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const head = ev.target.closest(".sechead");
    if (!head) return;
    ev.preventDefault();
    toggle(head);
  });
}

/* --------------------------------------------------------------- repaint - */

function repaint() {
  renderDays();
  renderStats();
  applyFilter(filter);   // which puts the pager back on the day it was on
}

/* ------------------------------------------------------------ sync badge - */

function initSyncBadge() {
  const paint = () => {
    el("sync").dataset.state = state.status;
    el("syncText").textContent = state.message;
  };
  subscribe(paint);
  paint(); // the first status was set before anyone was listening

  el("sync").addEventListener("click", async () => {
    toast("Checking for changes…");
    const before = JSON.stringify(state.data);
    await pull();
    if (JSON.stringify(state.data) !== before) {
      repaint();
      toast("Updated");
    } else {
      toast("Already up to date");
    }
  });
}

/* ---------------------------------------------------------------- setup -- */

function showSetup() {
  el("setup").classList.remove("hidden");
  el("app").classList.add("hidden");
  el("fab").classList.add("hidden");

  const input = el("tokenin");
  const button = el("tokensave");
  const error = el("tokenerr");

  const attempt = async () => {
    const token = input.value.trim();
    if (!token) return;
    button.disabled = true;
    button.textContent = "Checking…";
    error.classList.remove("on");

    const res = await verifyToken(token);
    if (!res.ok) {
      button.disabled = false;
      button.textContent = "Connect";
      error.textContent = res.error;
      error.classList.add("on");
      return;
    }
    setToken(token);
    location.reload();
  };

  button.addEventListener("click", attempt);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") attempt();
  });
}

/** Lets a second device be set up by opening a link with #token=… on it. */
function tokenFromUrl() {
  const m = location.hash.match(/token=([^&]+)/);
  if (!m) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return decodeURIComponent(m[1]);
}

/* ------------------------------------------------------------------ boot - */

async function boot() {
  const fromUrl = tokenFromUrl();
  if (fromUrl) setToken(fromUrl);

  if (!getToken() && !LOCAL && !DEMO) return showSetup();

  const ok = await init();
  if (!ok) {
    if (state.status === "error" && state.message === "Token rejected") {
      clearToken();
      return showSetup();
    }
    // Offline with nothing cached is the one dead end.
    el("setup").classList.remove("hidden");
    el("tokenerr").textContent =
      "Could not reach GitHub and there is nothing saved on this device yet.";
    el("tokenerr").classList.add("on");
    return;
  }

  el("setup").classList.add("hidden");
  el("app").classList.remove("hidden");
  el("fab").classList.remove("hidden");

  renderAll();
  // The filter's wording is personal, so it lives in the private itinerary
  // rather than in the public shell.
  el("fbtn-tentative").textContent =
    state.data.trip.tentativeLabel || "Tentative";
  applyFilter("all");

  el("filters").addEventListener("click", (ev) => {
    const b = ev.target.closest(".fbtn");
    if (b) applyFilter(b.dataset.f);
  });

  // Tap opens the place sheet; a hold turns into a drag and swallows the tap.
  el("days").addEventListener("click", (ev) => {
    if (swallowedClick() || editorOpen()) return;
    const entry = ev.target.closest(".entry");
    if (entry && entry.dataset.id) openSheet(entry);
  });
  el("days").addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const entry = ev.target.closest(".entry");
    if (entry && entry.dataset.id) {
      ev.preventDefault();
      openSheet(entry);
    }
  });

  // Only one day is on screen at a time, so dragging an entry to the edge has
  // to turn the page for the drop to be possible at all.
  initDrag(el("days"), repaint, { onEdge: nudgeDay });

  initPager({
    blocked: () =>
      isDragging() ||
      placesOpen() ||
      editorOpen() ||
      el("chat").classList.contains("on") ||
      el("mapscrim").classList.contains("on"),
  });
  initPlaces({ onSpot: openSpotSheet });
  initSheet();
  initSections();
  initSyncBadge();
  initEditor({
    toast,
    onSaved: (added) => {
      repaint();
      toast(added ? "Added" : "Saved");
    },
    onDeleted: (name) => {
      repaint();
      toast(`Deleted ${name}`);
    },
  });

  el("fab").addEventListener("click", () => openEditor(null, repaint));

  // --- the assistant ------------------------------------------------------
  el("chatfab").classList.remove("hidden");

  const openChat = () => {
    el("chat").classList.add("on");
    el("fab").classList.add("away");
    el("chatfab").classList.add("away");
    lockViewport();
    // After lockViewport, which is what gives the panel its final height.
    revealChat();
    haptic("light");
  };
  const closeChat = () => {
    unlockViewport();
    el("chat").classList.remove("on");
    el("fab").classList.remove("away");
    el("chatfab").classList.remove("away");
  };

  el("chatfab").addEventListener("click", openChat);
  el("chatback").addEventListener("click", closeChat);

  const sheet = el("chatsheet");
  el("chatgear").addEventListener("click", () => sheet.classList.add("on"));
  sheet.addEventListener("click", (ev) => {
    if (ev.target === sheet) sheet.classList.remove("on");
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (sheet.classList.contains("on")) sheet.classList.remove("on");
    else if (el("chat").classList.contains("on")) closeChat();
  });

  // A confirmed proposal writes through the same store as manual edits, so the
  // calendar just needs repainting.
  initChat({ onItineraryChanged: repaint });

  // Re-render when a background sync brings in someone else's change.
  let lastSeen = JSON.stringify(state.data);
  subscribe(() => {
    if (editorOpen()) return;
    const now = JSON.stringify(state.data);
    if (now !== lastSeen) {
      lastSeen = now;
      repaint();
    }
  });
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register(`sw.js?v=${SHELL_VERSION}`).catch(() => {})
  );
}

boot();

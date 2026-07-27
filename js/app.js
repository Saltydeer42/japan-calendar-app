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
import { renderAll, renderDays, renderStats } from "./render.js";
import { initDrag, swallowedClick } from "./drag.js";
import { initEditor, openEditor, editorOpen } from "./editor.js";

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
  document.querySelectorAll(".entry").forEach((e) =>
    e.classList.toggle("hidden", !matches(e, f))
  );
  document.querySelectorAll(".day").forEach((d) => {
    const shown = d.querySelectorAll(".entry:not(.hidden)").length;
    // With a filter on, an empty day is noise. With no filter it is a target.
    d.classList.toggle("hidden", f !== "all" && shown === 0);
  });
  document.querySelectorAll(".fbtn").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.f === f))
  );
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

function openSheet(entry) {
  const id = entry.dataset.id;
  const event = state.data.events.find((e) => e.id === id);
  if (!event) return;

  sheetEventId = id;
  sheetPlace = event.place || "";

  sheet.name.textContent = event.label || event.title;
  sheet.addr.textContent = event.place || "No address on this one";

  const hasPlace = !!event.place;
  const q = encodeURIComponent(event.place || "");
  sheet.apple.href = `https://maps.apple.com/?q=${q}`;
  sheet.google.href = `https://www.google.com/maps/search/?api=1&query=${q}`;
  sheet.apple.classList.toggle("hidden", !hasPlace);
  sheet.google.classList.toggle("hidden", !hasPlace);
  el("actcopy").classList.toggle("hidden", !hasPlace);
  sheet.copyTxt.textContent = "Copy address";

  lastFocus = document.activeElement;
  sheet.scrim.classList.add("on");
  (hasPlace ? sheet.apple : el("actedit")).focus();
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

/* --------------------------------------------------------------- repaint - */

function repaint() {
  renderDays();
  renderStats();
  applyFilter(filter);
}

/* ------------------------------------------------------------ sync badge - */

function initSyncBadge() {
  subscribe(() => {
    const b = el("sync");
    b.dataset.state = state.status;
    el("syncText").textContent = state.message;
  });

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

  initDrag(el("days"), repaint);
  initSheet();
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

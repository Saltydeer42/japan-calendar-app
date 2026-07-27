/* ==========================================================================
   store.js — the itinerary, and the GitHub repo it is kept in.

   The repo is the database. Reads are a GET of one JSON file, writes are a
   commit. That gives version history and rollback for free, and means a change
   made on one phone shows up on the other without anything being deployed.

   Everything renders from the local cache first so a cold launch on airport
   wifi is instant, then the network catches up.
   ========================================================================== */

import { REPO } from "./config.js";

const API = "https://api.github.com";
const KEY = {
  token: "jc.token",
  doc: "jc.doc",
  sha: "jc.sha",
  ops: "jc.ops",
};

/* Served from a local checkout, the app reads data/itinerary.json off disk and
   keeps edits in memory. Lets the UI be worked on without a token, and without
   a stray commit for every experiment. */
export const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const LOCAL_SOURCE = "../data/itinerary.json";

/* ?demo=1 runs the app on fabricated data with the network switched off. */
export const DEMO = new URLSearchParams(location.search).get("demo") === "1";

/* ---------------------------------------------------------------- state -- */

export const state = {
  data: null,       // the itinerary document
  sha: null,        // blob sha of what we last saw on the server
  ops: [],          // local edits not yet accepted by the server
  status: "ok",     // ok | saving | dirty | offline | error
  message: "Synced",
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  listeners.forEach((fn) => fn(state));
}

function setStatus(status, message) {
  state.status = status;
  state.message = message;
  emit();
}

/* ---------------------------------------------------------------- token -- */

export function getToken() {
  return localStorage.getItem(KEY.token) || "";
}

export function setToken(t) {
  localStorage.setItem(KEY.token, t.trim());
}

export function clearToken() {
  [KEY.token, KEY.doc, KEY.sha, KEY.ops].forEach((k) => localStorage.removeItem(k));
}

/* ------------------------------------------------------------- encoding -- */
// btoa/atob are byte-oriented and the itinerary is full of ·, — and ’.

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* -------------------------------------------------------------- caching -- */

function cacheDoc() {
  try {
    localStorage.setItem(KEY.doc, JSON.stringify(state.data));
    localStorage.setItem(KEY.sha, state.sha || "");
    localStorage.setItem(KEY.ops, JSON.stringify(state.ops));
  } catch (e) {
    /* quota — not fatal, the network copy is still authoritative */
  }
}

function readCache() {
  try {
    const raw = localStorage.getItem(KEY.doc);
    if (!raw) return false;
    state.data = JSON.parse(raw);
    state.sha = localStorage.getItem(KEY.sha) || null;
    state.ops = JSON.parse(localStorage.getItem(KEY.ops) || "[]");
    return true;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ api -- */

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  return res;
}

const contentsPath = () =>
  `/repos/${REPO.owner}/${REPO.name}/contents/${REPO.path}`;

/** Confirms a token can actually read the file. Used by the setup screen. */
export async function verifyToken(token) {
  const res = await fetch(
    `${API}${contentsPath()}?ref=${REPO.branch}&t=${Date.now()}`,
    {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  if (res.ok) return { ok: true };
  if (res.status === 401) return { ok: false, error: "GitHub rejected that token. Check it was copied whole." };
  if (res.status === 403) return { ok: false, error: "That token is missing Contents access to the repo." };
  if (res.status === 404) {
    return {
      ok: false,
      error: `Cannot see ${REPO.owner}/${REPO.name}. Give the token access to that repository specifically.`,
    };
  }
  return { ok: false, error: `GitHub returned ${res.status}.` };
}

/* ------------------------------------------------------------------ ops -- */
// A pending edit is recorded as an op so that if someone else commits while we
// are offline, we can replay our edits onto their version instead of
// clobbering it.

function recordOp(op) {
  state.ops = state.ops.filter((o) => o.id !== op.id);
  state.ops.push(op);
}

function applyOps(doc, ops) {
  for (const op of ops) {
    const i = doc.events.findIndex((e) => e.id === op.id);
    if (op.t === "delete") {
      if (i >= 0) doc.events.splice(i, 1);
    } else if (i >= 0) {
      doc.events[i] = op.event;
    } else {
      doc.events.push(op.event);
    }
  }
  return doc;
}

/* ----------------------------------------------------------------- pull -- */

export async function pull() {
  if (DEMO) {
    if (!state.data) {
      const { DEMO_DOC } = await import("./demo.js");
      state.data = JSON.parse(JSON.stringify(DEMO_DOC));
    }
    setStatus("ok", "Demo · not saved");
    return true;
  }

  if (LOCAL && !getToken()) {
    try {
      const res = await fetch(`${LOCAL_SOURCE}?t=${Date.now()}`, { cache: "no-store" });
      state.data = await res.json();
      state.sha = null;
      setStatus("ok", "Local file");
      return true;
    } catch (e) {
      setStatus("error", "No local itinerary.json");
      return false;
    }
  }

  if (!navigator.onLine) {
    setStatus(state.ops.length ? "dirty" : "offline", "Offline");
    return false;
  }
  try {
    const res = await api(`${contentsPath()}?ref=${REPO.branch}&t=${Date.now()}`);
    if (!res.ok) {
      setStatus("error", res.status === 401 ? "Token rejected" : `Error ${res.status}`);
      return false;
    }
    const json = await res.json();
    const remote = JSON.parse(fromBase64(json.content));
    state.sha = json.sha;

    // Our unsent edits win over the copy we just fetched; they get pushed next.
    state.data = state.ops.length ? applyOps(remote, state.ops) : remote;
    cacheDoc();

    if (state.ops.length) {
      setStatus("dirty", "Saving…");
      push();
    } else {
      setStatus("ok", "Synced");
    }
    emit();
    return true;
  } catch (e) {
    setStatus(state.ops.length ? "dirty" : "offline", "Offline");
    return false;
  }
}

/* ----------------------------------------------------------------- push -- */

let pushTimer = null;
let pushing = false;

export function push({ immediate = false } = {}) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(doPush, immediate ? 0 : 700);
}

async function doPush(attempt = 0) {
  if (pushing || !state.ops.length) return;
  if (DEMO) {
    state.ops = [];
    setStatus("ok", "Demo · not saved");
    return;
  }
  if (LOCAL && !getToken()) {
    state.ops = [];
    setStatus("ok", "Local file · not saved");
    return;
  }
  if (!navigator.onLine) {
    setStatus("dirty", "Offline · will save");
    return;
  }

  pushing = true;
  const sending = [...state.ops];
  setStatus("saving", "Saving…");

  try {
    const body = {
      message: commitMessage(sending),
      content: toBase64(JSON.stringify(state.data, null, 2) + "\n"),
      branch: REPO.branch,
      ...(state.sha ? { sha: state.sha } : {}),
    };

    const res = await api(contentsPath(), {
      method: "PUT",
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const json = await res.json();
      state.sha = json.content.sha;
      // Anything queued while this request was in flight stays queued.
      state.ops = state.ops.filter((o) => !sending.includes(o));
      cacheDoc();
      pushing = false;
      if (state.ops.length) return doPush();
      setStatus("ok", "Saved");
      setTimeout(() => state.status === "ok" && setStatus("ok", "Synced"), 1600);
      return;
    }

    // 409/422 mean someone else committed first. Take their version and
    // replay our edits on top rather than overwriting them.
    if ((res.status === 409 || res.status === 422) && attempt < 2) {
      pushing = false;
      const fresh = await api(`${contentsPath()}?ref=${REPO.branch}&t=${Date.now()}`);
      if (fresh.ok) {
        const json = await fresh.json();
        state.sha = json.sha;
        state.data = applyOps(JSON.parse(fromBase64(json.content)), state.ops);
        cacheDoc();
        emit();
        return doPush(attempt + 1);
      }
    }

    pushing = false;
    setStatus("error", res.status === 401 ? "Token rejected" : `Save failed (${res.status})`);
  } catch (e) {
    pushing = false;
    setStatus("dirty", "Offline · will save");
  }
}

function commitMessage(ops) {
  if (ops.length === 1) {
    const op = ops[0];
    const title = op.event ? op.event.title : op.id;
    return op.t === "delete" ? `Remove ${title}` : `Update ${title}`;
  }
  return `Update ${ops.length} entries`;
}

/* ------------------------------------------------------------ mutations -- */

export function upsertEvent(event) {
  const i = state.data.events.findIndex((e) => e.id === event.id);
  if (i >= 0) state.data.events[i] = event;
  else state.data.events.push(event);
  recordOp({ t: "upsert", id: event.id, event: JSON.parse(JSON.stringify(event)) });
  cacheDoc();
  emit();
  push();
}

export function deleteEvent(id) {
  const i = state.data.events.findIndex((e) => e.id === id);
  if (i < 0) return;
  state.data.events.splice(i, 1);
  recordOp({ t: "delete", id });
  cacheDoc();
  emit();
  push();
}

/** Drops an event onto a day, between the entries either side of the gap. */
export function moveEvent(id, date, before, after) {
  const ev = state.data.events.find((e) => e.id === id);
  if (!ev) return;
  ev.date = date;
  ev.sort = gapSort(before, after);
  recordOp({ t: "upsert", id: ev.id, event: JSON.parse(JSON.stringify(ev)) });
  cacheDoc();
  emit();
  push();
}

function gapSort(before, after) {
  if (before && after) return (before.sort + after.sort) / 2;
  if (before) return before.sort + 1000;
  if (after) return after.sort - 1000;
  return 1000;
}

export function nextSortFor(date) {
  const day = state.data.events.filter((e) => e.date === date);
  return day.length ? Math.max(...day.map((e) => e.sort)) + 1000 : 1000;
}

export function makeId(title, date) {
  const base =
    date.slice(5).replace("-", "") +
    "-" +
    (title || "event")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 40);
  let id = base;
  let n = 2;
  while (state.data.events.some((e) => e.id === id)) id = `${base}-${n++}`;
  return id;
}

/* ------------------------------------------------------------------ init - */

export async function init() {
  if (DEMO) return pull();
  if (LOCAL && !getToken()) return pull();

  const cached = readCache();
  if (cached) {
    setStatus(state.ops.length ? "dirty" : "ok", state.ops.length ? "Saving…" : "Synced");
    emit();
  }

  window.addEventListener("online", () => {
    if (state.ops.length) push({ immediate: true });
    else pull();
  });
  window.addEventListener("offline", () =>
    setStatus(state.ops.length ? "dirty" : "offline", "Offline")
  );

  // Coming back to the app is the moment the other phone's edits should land.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !state.ops.length) pull();
  });

  const ok = await pull();
  return ok || cached;
}

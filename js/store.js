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
    state.data = normalize(JSON.parse(raw));
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

/* ------------------------------------------------------------ normalise -- */
// Events and saved spots carry their own ids. The legs, the board rows and the
// rules never needed one while they were read-only, and now that the assistant
// can edit them they do: an op has to name the thing it changes. The ids are
// derived from the text, so two phones normalising the same document
// independently arrive at the same ids and their edits still line up.

export function slugify(s, max = 40) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, max)
    .replace(/-+$/, "");
}

function uniqueId(base, taken) {
  let id = base || "item";
  let n = 2;
  while (taken.has(id)) id = `${base || "item"}-${n++}`;
  taken.add(id);
  return id;
}

/** Ids for everything the assistant can address, and the split of a leg's
 *  "Area · dates" line into the two fields it is built from. Idempotent. */
export function normalize(doc) {
  if (!doc) return doc;

  const stays = new Set();
  for (const l of doc.legs || []) {
    if (!l.id) l.id = uniqueId(`stay-${slugify(l.name)}`, stays);
    else stays.add(l.id);
    if (l.area === undefined || l.dates === undefined) {
      const [area, dates] = String(l.meta || "").split("·").map((s) => s.trim());
      if (l.area === undefined) l.area = area || "";
      if (l.dates === undefined) l.dates = dates || "";
    }
  }

  const rows = new Set();
  for (const g of doc.board?.groups || []) {
    for (const r of g.rows || []) {
      if (!r.id) r.id = uniqueId(`row-${slugify(r.what)}`, rows);
      else rows.add(r.id);
    }
  }

  // Rules were plain strings. They are {id, text} now so one can be edited
  // without counting list positions.
  if (doc.rules?.items) {
    const ids = new Set();
    doc.rules.items = doc.rules.items.map((i) => {
      const item = typeof i === "string" ? { text: i } : { ...i };
      if (!item.id) item.id = uniqueId(`rule-${slugify(item.text)}`, ids);
      else ids.add(item.id);
      return item;
    });
  }

  return doc;
}

/* ------------------------------------------------------------------ ops -- */
// A pending edit is recorded as an op so that if someone else commits while we
// are offline, we can replay our edits onto their version instead of
// clobbering it. `scope` says which collection the op addresses; ops written
// before there was more than one collection have no scope and mean events.

const scopeOf = (op) => op.scope || "events";

function recordOp(op) {
  state.ops = state.ops.filter(
    (o) => !(scopeOf(o) === scopeOf(op) && o.id === op.id)
  );
  state.ops.push(op);
}

/** Records the op, saves, repaints and schedules the push. Every mutation
 *  below ends here, which is what keeps GitHub sync working for all of them. */
function commit(op) {
  recordOp(op);
  cacheDoc();
  emit();
  push();
}

function upsertById(list, id, value) {
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list[i] = value;
  else list.push(value);
}

function deleteById(list, id) {
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list.splice(i, 1);
}

/** Finds a board row by id, wherever it is sitting. */
function findRow(doc, id) {
  for (const group of doc.board?.groups || []) {
    const i = (group.rows || []).findIndex((r) => r.id === id);
    if (i >= 0) return { group, i };
  }
  return null;
}

export function applyOps(doc, ops) {
  normalize(doc);
  for (const op of ops) {
    switch (scopeOf(op)) {
      case "events": {
        if (op.t === "delete") deleteById(doc.events, op.id);
        else upsertById(doc.events, op.id, op.event);
        break;
      }
      case "places": {
        if (!doc.places) doc.places = { items: [] };
        if (!doc.places.items) doc.places.items = [];
        if (op.t === "delete") deleteById(doc.places.items, op.id);
        else upsertById(doc.places.items, op.id, op.place);
        break;
      }
      case "board": {
        const at = findRow(doc, op.id);
        if (op.t === "delete") {
          if (at) at.group.rows.splice(at.i, 1);
          break;
        }
        // Same group: replace in place so the row keeps its position. A
        // different one: lift it out and append to the group it is headed for.
        if (at && at.group.heading === op.group) {
          at.group.rows[at.i] = op.row;
          break;
        }
        if (at) at.group.rows.splice(at.i, 1);
        const groups = doc.board?.groups || [];
        let target = groups.find((g) => g.heading === op.group);
        if (!target) {
          if (!doc.board) doc.board = { groups: [] };
          if (!doc.board.groups) doc.board.groups = [];
          target = { heading: op.group, rows: [] };
          doc.board.groups.push(target);
        }
        if (!target.rows) target.rows = [];
        target.rows.push(op.row);
        break;
      }
      case "rules": {
        if (!doc.rules) doc.rules = { title: "Cash and timing rules", items: [] };
        if (!doc.rules.items) doc.rules.items = [];
        if (op.t === "delete") deleteById(doc.rules.items, op.id);
        else upsertById(doc.rules.items, op.id, op.item);
        break;
      }
      case "legs": {
        if (!doc.legs) doc.legs = [];
        if (op.t === "delete") deleteById(doc.legs, op.id);
        else upsertById(doc.legs, op.id, op.leg);
        break;
      }
    }
  }
  return doc;
}

/* ----------------------------------------------------------------- pull -- */

export async function pull() {
  if (DEMO) {
    if (!state.data) {
      const { DEMO_DOC } = await import("./demo.js");
      state.data = normalize(JSON.parse(JSON.stringify(DEMO_DOC)));
    }
    setStatus("ok", "Demo · not saved");
    return true;
  }

  if (LOCAL && !getToken()) {
    try {
      const res = await fetch(`${LOCAL_SOURCE}?t=${Date.now()}`, { cache: "no-store" });
      state.data = normalize(await res.json());
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
    state.data = state.ops.length
      ? applyOps(remote, state.ops)
      : normalize(remote);
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
    const title = op.title || op.event?.title || op.id;
    return op.t === "delete" ? `Remove ${title}` : `Update ${title}`;
  }
  return `Update ${ops.length} entries`;
}

/* ------------------------------------------------------------ mutations -- */

const clone = (x) => JSON.parse(JSON.stringify(x));

export function upsertEvent(event) {
  upsertById(state.data.events, event.id, event);
  commit({ t: "upsert", id: event.id, title: event.title, event: clone(event) });
}

export function deleteEvent(id) {
  const ev = state.data.events.find((e) => e.id === id);
  if (!ev) return;
  deleteById(state.data.events, id);
  commit({ t: "delete", id, title: ev.title });
}

/** Drops an event onto a day, between the entries either side of the gap. */
export function moveEvent(id, date, before, after) {
  const ev = state.data.events.find((e) => e.id === id);
  if (!ev) return;
  ev.date = date;
  ev.sort = gapSort(before, after);
  commit({ t: "upsert", id: ev.id, title: ev.title, event: clone(ev) });
}

/* --- saved spots -------------------------------------------------------- */

export function upsertPlace(place) {
  if (!state.data.places) state.data.places = { items: [] };
  if (!state.data.places.items) state.data.places.items = [];
  upsertById(state.data.places.items, place.id, place);
  commit({
    t: "upsert",
    scope: "places",
    id: place.id,
    title: place.name,
    place: clone(place),
  });
}

export function deletePlace(id) {
  const items = state.data.places?.items;
  const p = items?.find((x) => x.id === id);
  if (!p) return;
  deleteById(items, id);
  commit({ t: "delete", scope: "places", id, title: p.name });
}

/* --- board rows --------------------------------------------------------- */

/** Writes a row into the group with this heading, moving it out of whatever
 *  group it was in. A row that is already there keeps its position. */
export function upsertBoardRow(row, heading) {
  const doc = state.data;
  applyOps(doc, [
    { t: "upsert", scope: "board", id: row.id, group: heading, row: clone(row) },
  ]);
  commit({
    t: "upsert",
    scope: "board",
    id: row.id,
    group: heading,
    title: row.what,
    row: clone(row),
  });
}

export function deleteBoardRow(id) {
  const at = findRow(state.data, id);
  if (!at) return;
  const what = at.group.rows[at.i].what;
  at.group.rows.splice(at.i, 1);
  commit({ t: "delete", scope: "board", id, title: what });
}

export function boardRow(id) {
  const at = findRow(state.data, id);
  return at ? { row: at.group.rows[at.i], heading: at.group.heading } : null;
}

export function boardHeadings() {
  return (state.data.board?.groups || []).map((g) => g.heading);
}

/* --- rules -------------------------------------------------------------- */

export function upsertRule(item) {
  if (!state.data.rules) {
    state.data.rules = { title: "Cash and timing rules", items: [] };
  }
  if (!state.data.rules.items) state.data.rules.items = [];
  upsertById(state.data.rules.items, item.id, item);
  commit({
    t: "upsert",
    scope: "rules",
    id: item.id,
    title: "the cash and timing rules",
    item: clone(item),
  });
}

export function deleteRule(id) {
  const items = state.data.rules?.items;
  if (!items?.some((i) => i.id === id)) return;
  deleteById(items, id);
  commit({
    t: "delete",
    scope: "rules",
    id,
    title: "a cash and timing rule",
  });
}

/* --- stays -------------------------------------------------------------- */

/** The leg card shows one line under the name, built from the area and the
 *  dates, so `meta` is recomputed rather than stored independently. */
export function upsertLeg(leg) {
  const next = {
    ...leg,
    meta: [leg.area, leg.dates].filter(Boolean).join(" · "),
  };
  if (!state.data.legs) state.data.legs = [];
  upsertById(state.data.legs, next.id, next);
  commit({
    t: "upsert",
    scope: "legs",
    id: next.id,
    title: next.name,
    leg: clone(next),
  });
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
  const base = date.slice(5).replace("-", "") + "-" + slugify(title || "event");
  return uniqueId(base, new Set(state.data.events.map((e) => e.id)));
}

export function makePlaceId(name) {
  const items = state.data.places?.items || [];
  return uniqueId(slugify(name) || "spot", new Set(items.map((p) => p.id)));
}

export function makeBoardRowId(what) {
  const taken = new Set();
  for (const g of state.data.board?.groups || []) {
    for (const r of g.rows || []) taken.add(r.id);
  }
  return uniqueId(`row-${slugify(what) || "item"}`, taken);
}

export function makeRuleId(text) {
  const items = state.data.rules?.items || [];
  return uniqueId(
    `rule-${slugify(text) || "item"}`,
    new Set(items.map((i) => i.id))
  );
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

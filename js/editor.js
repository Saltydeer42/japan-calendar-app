/* ==========================================================================
   editor.js — the add / edit sheet.
   ========================================================================== */

import { PILL_STYLES } from "./config.js";
import {
  state,
  upsertEvent,
  deleteEvent,
  nextSortFor,
  makeId,
} from "./store.js";
import { eachDate, dayNumber, weekday, esc } from "./render.js";

const el = (id) => document.getElementById(id);

let editing = null;      // the event being edited, or null for a new one
let onDone = () => {};

/* ---------------------------------------------------------------- chips -- */

function chipValue(group) {
  const on = group.querySelector('[aria-pressed="true"]');
  return on ? on.dataset.v : null;
}

function setChip(group, value) {
  [...group.children].forEach((c) =>
    c.setAttribute("aria-pressed", String(c.dataset.v === value))
  );
}

function wireChips(group) {
  group.addEventListener("click", (ev) => {
    const chip = ev.target.closest(".chip");
    if (chip) setChip(group, chip.dataset.v);
  });
}

/* ---------------------------------------------------------------- pills -- */

function pillRow(pill = { text: "", style: "plain" }) {
  const row = document.createElement("div");
  row.className = "pillrow";

  const input = document.createElement("input");
  input.type = "text";
  input.value = pill.text;
  input.placeholder = "Cash only";

  const select = document.createElement("select");
  select.innerHTML = Object.entries(PILL_STYLES)
    .map(([v, label]) => `<option value="${v}">${esc(label)}</option>`)
    .join("");
  select.value = pill.style || "plain";

  const remove = document.createElement("button");
  remove.className = "xbtn";
  remove.type = "button";
  remove.innerHTML = "&times;";
  remove.setAttribute("aria-label", "Remove tag");
  remove.addEventListener("click", () => row.remove());

  row.append(input, select, remove);
  return row;
}

function readPills() {
  return [...el("f-pills").querySelectorAll(".pillrow")]
    .map((row) => ({
      text: row.querySelector("input").value.trim(),
      style: row.querySelector("select").value,
    }))
    .filter((p) => p.text);
}

/* ----------------------------------------------------------------- open -- */

export function openEditor(event, done) {
  editing = event || null;
  onDone = done || (() => {});

  el("edtitle").textContent = event ? "Edit event" : "New event";
  el("f-deletewrap").classList.toggle("hidden", !event);

  const dates = eachDate(state.data.trip.start, state.data.trip.end);
  el("f-date").innerHTML = dates
    .map((d) => `<option value="${d}">${weekday(d)} ${dayNumber(d)}</option>`)
    .join("");

  const e = event || {
    title: "",
    cat: "eat",
    status: "tentative",
    kicker: "",
    time: "",
    timeHard: false,
    place: "",
    note: "",
    pills: [],
    date: dates[0],
  };

  el("f-title").value = e.title || "";
  el("f-date").value = e.date;
  el("f-kicker").value = e.kicker || "";
  el("f-time").value = e.time || "";
  el("f-place").value = e.place || "";
  el("f-note").value = e.note || "";
  setChip(el("f-cat"), e.cat);
  setChip(el("f-status"), e.status);
  el("f-hard").setAttribute("aria-checked", String(!!e.timeHard));

  el("f-pills").innerHTML = "";
  (e.pills || []).forEach((p) => el("f-pills").appendChild(pillRow(p)));

  el("bscrim").classList.add("on");
  el("editor").classList.add("on");
  el("fab").classList.add("away");
  el("editor").querySelector(".bbody").scrollTop = 0;

  if (!event) setTimeout(() => el("f-title").focus(), 340);
}

export function closeEditor() {
  el("bscrim").classList.remove("on");
  el("editor").classList.remove("on");
  el("fab").classList.remove("away");
  editing = null;
}

export function editorOpen() {
  return el("editor").classList.contains("on");
}

/* ----------------------------------------------------------------- save -- */

function save() {
  const title = el("f-title").value.trim();
  if (!title) {
    el("f-title").focus();
    return { ok: false, error: "Give it a title first." };
  }

  const date = el("f-date").value;
  const cat = chipValue(el("f-cat")) || "eat";
  const status = chipValue(el("f-status")) || "tentative";

  const next = {
    ...(editing || {}),
    id: editing ? editing.id : makeId(title, date),
    date,
    cat,
    status,
    kicker: el("f-kicker").value.trim() || defaultKicker(cat),
    time: el("f-time").value.trim(),
    timeHard: el("f-hard").getAttribute("aria-checked") === "true",
    title,
    label: title,
    note: el("f-note").value.trim(),
    place: el("f-place").value.trim(),
    pills: readPills(),
  };

  // A new event, or one dragged to a different day, goes to the end of it.
  if (!editing) next.sort = nextSortFor(date);
  else if (editing.date !== date) next.sort = nextSortFor(date);

  upsertEvent(next);
  return { ok: true, added: !editing };
}

function defaultKicker(cat) {
  return {
    travel: "Travel",
    stay: "Hotel",
    eat: "Meal",
    drink: "Drink",
    see: "See",
    shop: "Shop",
    book: "To book",
  }[cat] || "Plan";
}

/* ----------------------------------------------------------------- wire -- */

export function initEditor({ onSaved, onDeleted, toast }) {
  wireChips(el("f-cat"));
  wireChips(el("f-status"));

  el("f-hard").addEventListener("click", (ev) => {
    const on = ev.currentTarget.getAttribute("aria-checked") === "true";
    ev.currentTarget.setAttribute("aria-checked", String(!on));
  });

  el("f-addpill").addEventListener("click", () => {
    el("f-pills").appendChild(pillRow());
    el("f-pills").lastChild.querySelector("input").focus();
  });

  el("edsave").addEventListener("click", () => {
    const res = save();
    if (!res.ok) return toast(res.error, true);
    closeEditor();
    onSaved(res.added);
  });

  el("edcancel").addEventListener("click", closeEditor);
  el("bscrim").addEventListener("click", closeEditor);

  // Two taps rather than a confirm() dialog: a modal alert over a bottom sheet
  // is jarring on a phone, and this cannot be dismissed by accident.
  let armed = null;
  const del = el("f-delete");
  const disarm = () => {
    clearTimeout(armed);
    armed = null;
    del.textContent = "Delete this event";
  };
  del.addEventListener("click", () => {
    if (!editing) return;
    if (!armed) {
      del.textContent = "Tap again to delete";
      armed = setTimeout(disarm, 3000);
      return;
    }
    disarm();
    const name = editing.title;
    deleteEvent(editing.id);
    closeEditor();
    onDeleted(name);
  });
  el("edcancel").addEventListener("click", disarm);
  el("bscrim").addEventListener("click", disarm);

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && editorOpen()) closeEditor();
  });
}

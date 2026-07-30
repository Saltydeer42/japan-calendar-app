/* ==========================================================================
   proposals.js — turning a tapped card into a change to the trip.

   agent.js decides what a proposal says; this decides what it does. One
   handler per tool, each ending in a store mutation, which is what keeps the
   GitHub sync, the local cache and the ICS working the same way for a saved
   spot as for a dinner reservation.

   Nothing here runs until the user taps Confirm.
   ========================================================================== */

import {
  state,
  upsertEvent,
  deleteEvent,
  upsertPlace,
  deletePlace,
  upsertBoardRow,
  deleteBoardRow,
  boardRow,
  upsertRule,
  deleteRule,
  upsertLeg,
  nextSortFor,
  makeId,
  makePlaceId,
  makeBoardRowId,
  makeRuleId,
} from "./store.js";

/* An empty string means "leave this alone", matching what the tool schemas
   tell the model. The fields that document an empty string as a clear are
   handled explicitly by their own handler instead. */
function assign(target, input, fields) {
  for (const k of fields) {
    const v = input[k];
    if (v === undefined) continue;
    if (typeof v === "string" && v === "") continue;
    target[k] = v;
  }
  return target;
}

/* Tags are a whole-list replacement, and an empty array is a real value: it
   clears them. */
function assignPills(target, input) {
  if (Array.isArray(input.pills)) {
    target.pills = input.pills
      .filter((p) => p && p.text)
      .map((p) => ({ text: String(p.text), style: p.style || "plain" }));
  }
  return target;
}

/* -------------------------------------------------------------- entries -- */

function addEvent(input) {
  const date = input.date;
  const event = {
    id: makeId(input.title, date),
    date,
    sort: nextSortFor(date),
    cat: input.cat,
    status: input.status,
    kicker: input.kicker || "Plan",
    time: input.time || "",
    timeHard: !!input.timeHard,
    title: input.title,
    label: input.title,
    note: input.note || "",
    place: input.place || "",
    pills: [],
  };
  upsertEvent(assignPills(event, input));
  return true;
}

const EVENT_FIELDS = [
  "title",
  "label",
  "cat",
  "time",
  "timeHard",
  "status",
  "kicker",
  "place",
  "note",
  "sort",
];

function updateEvent(input) {
  const existing = state.data.events.find((e) => e.id === input.id);
  if (!existing) return false;
  const next = assign({ ...existing }, input, EVENT_FIELDS);
  assignPills(next, input);
  // The map sheet's label follows the title unless the model set it itself.
  if (input.title && input.label === undefined) next.label = input.title;
  upsertEvent(next);
  return true;
}

function moveEventProposal(input) {
  const existing = state.data.events.find((e) => e.id === input.id);
  if (!existing) return false;
  const next = { ...existing, date: input.date };
  if (input.time) next.time = input.time;
  if (existing.date !== input.date) next.sort = nextSortFor(input.date);
  upsertEvent(next);
  return true;
}

/* ----------------------------------------------------------- saved spots -- */

const PLACE_FIELDS = ["name", "cat", "kind", "area", "city", "note", "query"];

/* A spot is on a day or in a bucket, never both: the day panel reads `date`
   and the buckets at the foot of the sheet only list spots without one. */
function assignSlot(place, input) {
  if (input.date) {
    place.date = input.date;
    delete place.bucket;
  } else if (input.bucket) {
    place.bucket = input.bucket;
    delete place.date;
  }
}

function addPlace(input) {
  const place = {
    id: makePlaceId(input.name),
    name: input.name,
    cat: input.cat,
    kind: input.kind,
    area: input.area || "",
    city: input.city,
  };
  if (input.note) place.note = input.note;
  if (input.query) place.query = input.query;
  if (input.tentative) place.tentative = true;
  assignSlot(place, input);
  // Somewhere to sit, or it renders nowhere at all.
  if (!place.date && !place.bucket) place.bucket = "no-day";
  upsertPlace(place);
  return true;
}

function updatePlace(input) {
  const existing = state.data.places?.items?.find((p) => p.id === input.id);
  if (!existing) return false;
  const next = assign({ ...existing }, input, PLACE_FIELDS);

  if (input.tentative !== undefined) {
    if (input.tentative) next.tentative = true;
    else delete next.tentative;
  }
  // Documented as clearable: an empty string means the place reopened.
  if (input.closed !== undefined) {
    if (input.closed) next.closed = input.closed;
    else delete next.closed;
  }
  assignSlot(next, input);

  upsertPlace(next);
  return true;
}

/* ---------------------------------------------------------------- board -- */

function addRow(input) {
  upsertBoardRow(
    {
      id: makeBoardRowId(input.what),
      status: input.status,
      label: input.label,
      what: input.what,
      why: input.why,
    },
    input.group
  );
  return true;
}

function updateRow(input) {
  const at = boardRow(input.id);
  if (!at) return false;
  const next = assign({ ...at.row }, input, ["status", "label", "what", "why"]);
  upsertBoardRow(next, at.heading);
  return true;
}

function moveRow(input) {
  const at = boardRow(input.id);
  if (!at) return false;
  const next = { ...at.row };
  if (input.status) next.status = input.status;
  upsertBoardRow(next, input.group);
  return true;
}

/* ---------------------------------------------------------------- rules -- */

function addRule(input) {
  upsertRule({ id: makeRuleId(input.text), text: input.text });
  return true;
}

function updateRule(input) {
  const existing = state.data.rules?.items?.find((i) => i.id === input.id);
  if (!existing) return false;
  upsertRule({ ...existing, text: input.text });
  return true;
}

/* ---------------------------------------------------------------- stays -- */

function updateStay(input) {
  const existing = (state.data.legs || []).find((l) => l.id === input.id);
  if (!existing) return false;
  const next = assign({ ...existing }, input, ["name", "area", "dates"]);
  // Documented as clearable, since a note is the one thing a stay may lose.
  if (input.note !== undefined) {
    if (input.note) next.note = input.note;
    else delete next.note;
  }
  upsertLeg(next);
  return true;
}

/* -------------------------------------------------------------- dispatch -- */

const HANDLERS = {
  propose_add: addEvent,
  propose_move: moveEventProposal,
  propose_update: updateEvent,
  propose_delete: (input) => {
    if (!state.data.events.some((e) => e.id === input.id)) return false;
    deleteEvent(input.id);
    return true;
  },

  propose_add_place: addPlace,
  propose_update_place: updatePlace,
  propose_delete_place: (input) => {
    if (!state.data.places?.items?.some((p) => p.id === input.id)) return false;
    deletePlace(input.id);
    return true;
  },

  propose_add_row: addRow,
  propose_update_row: updateRow,
  propose_move_row: moveRow,
  propose_delete_row: (input) => {
    if (!boardRow(input.id)) return false;
    deleteBoardRow(input.id);
    return true;
  },

  propose_add_rule: addRule,
  propose_update_rule: updateRule,
  propose_delete_rule: (input) => {
    if (!state.data.rules?.items?.some((i) => i.id === input.id)) return false;
    deleteRule(input.id);
    return true;
  },

  propose_update_stay: updateStay,
};

/**
 * Applies one confirmed proposal.
 *
 * @returns {boolean} false when it could not be applied — the thing it names
 *   is gone, or the tool is one we don't know. The card then reads as
 *   dismissed rather than pretending to have worked.
 */
export function applyProposal(name, input) {
  const handler = HANDLERS[name];
  if (!handler || !input) return false;
  try {
    return handler(input);
  } catch (e) {
    return false;
  }
}

/** The tools that remove something, so a card can say Delete on its button. */
export function isDestructive(name) {
  return /^propose_delete/.test(name);
}

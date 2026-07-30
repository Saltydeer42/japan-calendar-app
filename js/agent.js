/* ==========================================================================
   agent.js — Claude Sonnet 5, with the itinerary in context and tools that
   propose changes to it.

   Raw HTTP rather than the SDK: this is a no-build vanilla-JS PWA, so there is
   no bundler to pull @anthropic-ai/sdk through.

   Every tool here only ever *proposes*. Nothing the model calls mutates the
   trip; it renders a card and waits for a tap. That is deliberate -- the model
   is reading a 60-entry itinerary over a phone connection and should not be
   able to quietly move a locked dinner reservation.
   ========================================================================== */

import { PILL_STYLES } from "./config.js";
import { state } from "./store.js";
import {
  eachDate,
  weekday,
  dayNumber,
  eventsOn,
  placesOn,
  placesInBucket,
  ruleText,
} from "./render.js";

const API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";
const KEY = "jc.akey";

/* ---------------------------------------------------------------- token -- */

export function getApiKey() {
  return localStorage.getItem(KEY) || "";
}

export function setApiKey(k) {
  localStorage.setItem(KEY, k.trim());
}

export function clearApiKey() {
  localStorage.removeItem(KEY);
}

/* --------------------------------------------------------------- context -- */

/* A compact rendering rather than the raw JSON: same information, far fewer
   tokens, and the ids stay visible so the model can reference entries. */
function itineraryText() {
  const d = state.data;
  const lines = [];

  lines.push(`# ${d.trip.title} — ${d.trip.dates}`);

  if (d.notice?.title) {
    lines.push(`\n## Standing notice: ${d.notice.title}`);
    (d.notice.body || []).forEach((p) =>
      lines.push(p.replace(/<[^>]+>/g, ""))
    );
  }

  if (d.legs?.length) {
    lines.push(`\n## Where we are staying`);
    d.legs.forEach((l) =>
      lines.push(
        `- [${l.id}] ${l.name} — ${l.meta || [l.area, l.dates].filter(Boolean).join(" · ")}` +
          (l.note ? ` — ${l.note.replace(/<[^>]+>/g, "")}` : "")
      )
    );
  }

  lines.push(`\n## Day by day`);
  for (const date of eachDate(d.trip.start, d.trip.end)) {
    const list = eventsOn(date);
    lines.push(`\n### ${weekday(date)} ${date}`);
    if (!list.length) {
      lines.push("(nothing scheduled)");
      continue;
    }
    for (const e of list) {
      const tags = (e.pills || []).map((p) => p.text).join(", ");
      lines.push(
        [
          `- [${e.id}]`,
          `${e.kicker} ·`,
          e.time ? `${e.time}${e.timeHard ? " (fixed)" : ""} ·` : "",
          e.title,
          `(${e.status})`,
          tags ? `[${tags}]` : "",
        ]
          .filter(Boolean)
          .join(" ")
      );
      if (e.place) lines.push(`    address: ${e.place}`);
      if (e.note) lines.push(`    note: ${e.note.replace(/<[^>]+>/g, "")}`);
    }
    const saved = placesOn(date);
    if (saved.length) {
      lines.push(
        `  saved spots on this day, nothing booked: ` +
          saved
            .map((p) => `[${p.id}] ${p.name} (${p.kind}, ${p.area})`)
            .join("; ")
      );
    }
  }

  if (d.places?.items?.length) {
    lines.push(`\n## Raquel's Map, the spots with no day`);
    for (const b of d.places.buckets || []) {
      const list = placesInBucket(b.key);
      if (!list.length) continue;
      lines.push(`\n### ${b.heading} (bucket: ${b.key})`);
      list.forEach((p) =>
        lines.push(
          `- [${p.id}] ${p.name} (${p.kind}, ${[p.area, p.city].filter(Boolean).join(", ")})` +
            (p.note ? ` — ${p.note.replace(/<[^>]+>/g, "")}` : "")
        )
      );
    }
  }

  if (d.board?.groups?.length) {
    lines.push(`\n## Booking board`);
    for (const g of d.board.groups) {
      lines.push(`\n### ${g.heading}`);
      for (const r of g.rows) {
        lines.push(
          `- [${r.id}] ${r.status} · ${r.label} · ${r.what} — ${r.why.replace(/<[^>]+>/g, "")}`
        );
      }
    }
  }

  if (d.rules?.items?.length) {
    lines.push(`\n## Cash and timing rules`);
    d.rules.items.forEach((i) =>
      lines.push(
        `- ${typeof i === "string" ? "" : `[${i.id}] `}${ruleText(i).replace(/<[^>]+>/g, "")}`
      )
    );
  }

  return lines.join("\n");
}

export function systemPrompt(nowISO) {
  const who = state.data.trip.travellers;
  const travellers = who ? ` The travellers are ${who}.` : "";
  return `You are the trip assistant for a two-person holiday in Japan, 14–30 August 2026. You live inside the travellers' own trip app, in a chat that looks like iMessage.${travellers}

Right now it is ${nowISO}. All trip times are Japan Standard Time.

# What you can and cannot do
You can answer anything about the itinerary below, and you can PROPOSE changes to any part of it using your tools. You cannot make real reservations — you have no phone, no email and no booking integrations. If something needs an actual booking, say who has to do it (them, or a hotel concierge) and offer to put it on the booking board.

Your tools only ever propose. A card appears in the chat and the user taps to confirm. So never say "done", "added", or "moved" — say what you're proposing and let the card speak. After calling a tool, keep your reply to a single short line; the card carries the detail.

Everything in the app is editable this way, and each part has its own tools. Every entry, spot, row, rule and hotel below is listed with its [id]; pass that id back exactly as written.

- The day-by-day entries, the timed plan itself: propose_add, propose_move, propose_update, propose_delete.
- The saved spots, "Raquel's Map": shops, cafes and sights one of them saved. Nothing there is booked or timed. A spot either sits on a day, behind that day's Raquel's Map row, or it sits in one of the buckets at the bottom of the sheet with the reason it never got a day. propose_add_place, propose_update_place, propose_delete_place. Putting a spot on a day is an update with a date; taking it off is an update with a bucket. A spot is still not a plan: if one deserves a real slot with a time on it, propose a new entry as well.
- The booking board, the "needs booking" list: propose_add_row, propose_update_row, propose_move_row, propose_delete_row. Once something is actually booked, that is usually two proposals, the entry set to locked and the board row moved to the done group.
- The cash and timing rules at the foot of the sheet: propose_add_rule, propose_update_rule, propose_delete_rule.
- The hotels: propose_update_stay.

Propose the smallest change that does the job, and only what was asked for. Two related edits are two cards, which is fine; a pile of six for one request is not.

# How to write
Three rules about style, and they are not negotiable.

1. Write in lowercase. All of it: the start of sentences, days of the week, city names, restaurant names. The one exception is codes that have to be read back accurately somewhere else, like a reservation reference, a flight number or a train number. Leave those exactly as they appear in the itinerary.

2. Never use an em dash or an en dash. Not for asides, not for ranges, not ever. Use a comma, a full stop, or the word "to". Write "8:30 to 10:00", not "8:30-10:00" and never "8:30 — 10:00".

3. Send more than one message when the reply has more than one thought. Separate them with a blank line and each becomes its own bubble, exactly like texting. A list of things and then your verdict on them is two messages, not one. Do not force it, but a single wall of text is almost always wrong.

Otherwise: text like a person, not a report. No headers, no bullet lists, no markdown, no bold. Lead with the answer, then the caveat.

Be concrete and use what you know. If asked where dinner is tonight, name the place, the time and the neighbourhood. If something is tentative or unbooked, say so. the difference between locked and tentative matters a lot to them.

Never invent an address, a reservation number, an opening time, or a train time. If it isn't below, say you don't have it. Guessing a restaurant's closing time is worse than useless to someone standing outside it.

# The itinerary

${itineraryText()}`;
}

/* ----------------------------------------------------------------- tools -- */

const DATE_DESC =
  "Date as YYYY-MM-DD. Must fall inside the trip, 2026-08-14 to 2026-08-30.";

/* The tags that hang off an entry's title. Same five styles the editor sheet
   offers, so anything the model proposes is something the app can already
   draw. */
const PILLS_PROP = {
  type: "array",
  description:
    "Replaces the entry's tags in full, so restate any that still apply. " +
    "Pass an empty array to clear them. This is where a reservation " +
    "reference, a flight number or a cash-only warning goes.",
  items: {
    type: "object",
    properties: {
      text: { type: "string", description: "Short tag text, e.g. 'Res 2022'." },
      style: {
        type: "string",
        enum: Object.keys(PILL_STYLES),
        description:
          "ref = a booking reference or number; cash = cash only; " +
          "pend = waiting on someone; flash = a tentative placeholder; " +
          "plain = anything else.",
      },
    },
    required: ["text"],
  },
};

const PLACE_CATS = ["eat", "drink", "see", "shop", "stay", "travel"];
const BOARD_STATUSES = ["done", "you", "wait", "cc"];

export const TOOLS = [
  {
    name: "propose_add",
    description:
      "Propose adding a new entry to the itinerary. Shows the user a confirmation card; it is NOT saved until they tap it.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: DATE_DESC },
        title: { type: "string", description: "The name of the place or thing." },
        cat: {
          type: "string",
          enum: ["travel", "stay", "eat", "drink", "see", "shop", "book"],
          description: "Category. 'book' means an outstanding thing to book.",
        },
        status: {
          type: "string",
          enum: ["locked", "tentative", "todo"],
          description:
            "locked = actually reserved; tentative = a placeholder idea; todo = still needs booking.",
        },
        kicker: {
          type: "string",
          description: "Short type label, e.g. Dinner, Bar, Temple, Train.",
        },
        time: {
          type: "string",
          description: "e.g. '7:30 PM', or a loose one like 'Evening'.",
        },
        timeHard: {
          type: "boolean",
          description: "True only for fixed times they cannot be late for.",
        },
        place: {
          type: "string",
          description:
            "Address for the maps link. Leave empty rather than inventing one.",
        },
        note: {
          type: "string",
          description:
            "A sentence of useful detail. Flight numbers, seat numbers and " +
            "what a booking covers live here.",
        },
        pills: PILLS_PROP,
        reason: {
          type: "string",
          description: "One short line for the user explaining the suggestion.",
        },
      },
      required: ["date", "title", "cat", "status", "kicker", "reason"],
    },
  },
  {
    name: "propose_move",
    description:
      "Propose moving an existing entry to a different day, or to a different position within its day.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The [id] of the entry to move." },
        date: { type: "string", description: DATE_DESC },
        time: {
          type: "string",
          description: "Optional new time. Omit to keep the current one.",
        },
        reason: { type: "string", description: "One short line for the user." },
      },
      required: ["id", "date", "reason"],
    },
  },
  {
    name: "propose_update",
    description:
      "Propose changing any field on an existing itinerary entry: its time, status, tags, note, address, title, category or position in the day. Only the day it sits on is somewhere else, on propose_move.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The [id] of the entry." },
        title: {
          type: "string",
          description: "New name. Omit unless the name itself is changing.",
        },
        cat: {
          type: "string",
          enum: ["travel", "stay", "eat", "drink", "see", "shop", "book"],
          description:
            "New category, which sets the colour of the row. 'book' means an " +
            "outstanding thing to book.",
        },
        time: {
          type: "string",
          description: "New time, e.g. '8:30 PM' or 'Evening'. Omit to leave it.",
        },
        timeHard: {
          type: "boolean",
          description:
            "Whether the time is fixed. Set true when a reservation pins it.",
        },
        status: {
          type: "string",
          enum: ["locked", "tentative", "todo"],
          description:
            "Set 'locked' once something is actually reserved — that is the most useful edit here.",
        },
        kicker: {
          type: "string",
          description: "New short type label, e.g. Dinner, Bar, Train.",
        },
        place: {
          type: "string",
          description:
            "New address for the maps link. Only if you genuinely have it.",
        },
        note: {
          type: "string",
          description:
            "Replaces the existing note in full, so restate anything still relevant.",
        },
        pills: PILLS_PROP,
        label: {
          type: "string",
          description:
            "The name used on the map sheet. Follows the title on its own; " +
            "only set this when it genuinely needs to differ.",
        },
        sort: {
          type: "number",
          description:
            "Position within its day, low to high. Rarely needed: use " +
            "propose_move to reorder a day instead.",
        },
        reason: { type: "string", description: "One short line for the user." },
      },
      required: ["id", "reason"],
    },
  },
  {
    name: "propose_delete",
    description: "Propose removing an entry from the itinerary.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The [id] of the entry." },
        reason: { type: "string", description: "One short line for the user." },
      },
      required: ["id", "reason"],
    },
  },

  /* --- saved spots, Raquel's Map --------------------------------------- */

  {
    name: "propose_add_place",
    description:
      "Propose saving a new spot to Raquel's Map. A spot is a candidate, not a plan: no time, nothing booked. Give it a date to hang it off a day, or a bucket to file it with the ones that never got a day.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the place." },
        cat: {
          type: "string",
          enum: PLACE_CATS,
          description: "Category, which sets the colour of the row.",
        },
        kind: {
          type: "string",
          description:
            "What it is, in one or two words: Coffee, Temple, Ramen, Vintage.",
        },
        area: {
          type: "string",
          description: "Neighbourhood, e.g. 'Gion' or 'Otemachi, Chiyoda'.",
        },
        city: { type: "string", description: "e.g. Tokyo, Kyoto, Osaka." },
        note: { type: "string", description: "A sentence on why it is worth it." },
        date: {
          type: "string",
          description: `${DATE_DESC} Sets which day's Raquel's Map it appears on. Omit to leave it off the days, in which case give a bucket.`,
        },
        bucket: {
          type: "string",
          description:
            "Which bucket it sits in when it has no day. Use one of the " +
            "bucket keys listed in Raquel's Map below, normally 'no-day'.",
        },
        tentative: {
          type: "boolean",
          description:
            "True when the details are unconfirmed, which tags the row " +
            "Unconfirmed.",
        },
        query: {
          type: "string",
          description:
            "Search text for the maps link, when the name alone would find " +
            "the wrong place. Defaults to the name and city.",
        },
        reason: { type: "string", description: "One short line for the user." },
      },
      required: ["name", "cat", "kind", "city", "reason"],
    },
  },
  {
    name: "propose_update_place",
    description:
      "Propose changing a saved spot on Raquel's Map, including moving it onto a day or taking it off one.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The [id] of the spot." },
        name: { type: "string", description: "New name." },
        cat: { type: "string", enum: PLACE_CATS, description: "New category." },
        kind: { type: "string", description: "New short kind, e.g. Kissaten." },
        area: { type: "string", description: "New neighbourhood." },
        city: { type: "string", description: "New city." },
        note: {
          type: "string",
          description: "Replaces the existing note in full.",
        },
        date: {
          type: "string",
          description: `${DATE_DESC} Puts the spot on that day. Clears the bucket, since a spot with a day is not waiting for one.`,
        },
        bucket: {
          type: "string",
          description:
            "Takes the spot off its day and files it: 'no-day' when there is " +
            "no slot for it, 'not-this-trip' when it is out of range, " +
            "'on-plan' when it is already on the sheet as a real entry, " +
            "'do-not-go' when it should not be visited.",
        },
        tentative: {
          type: "boolean",
          description: "Whether the details are unconfirmed.",
        },
        closed: {
          type: "string",
          enum: ["", "temporarily", "permanently"],
          description:
            "Marks the spot closed, which tags the row. Empty string clears it.",
        },
        query: {
          type: "string",
          description: "New search text for the maps link.",
        },
        reason: { type: "string", description: "One short line for the user." },
      },
      required: ["id", "reason"],
    },
  },
  {
    name: "propose_delete_place",
    description:
      "Propose removing a spot from Raquel's Map altogether. Prefer moving it to the 'not-this-trip' or 'do-not-go' bucket, which keeps the reason visible.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The [id] of the spot." },
        reason: { type: "string", description: "One short line for the user." },
      },
      required: ["id", "reason"],
    },
  },

  /* --- the booking board ------------------------------------------------ */

  {
    name: "propose_add_row",
    description:
      "Propose adding a row to the booking board, the 'needs booking' list. Use this for anything outstanding: a table to reserve, a ticket to buy, a form to sign.",
    input_schema: {
      type: "object",
      properties: {
        group: {
          type: "string",
          description:
            "The heading of the group it belongs under, copied exactly from " +
            "the booking board below. A heading that does not exist yet " +
            "starts a new group, so only do that deliberately.",
        },
        status: {
          type: "string",
          enum: BOARD_STATUSES,
          description:
            "done = nothing left to do; you = they have to act; " +
            "wait = waiting on someone else; cc = blocked or a dead end.",
        },
        label: {
          type: "string",
          description:
            "The tag on the left of the row, one or two words: Book now, " +
            "Tickets, Awaiting, Accepted, Sign.",
        },
        what: {
          type: "string",
          description:
            "The thing itself, e.g. 'teamLab Borderless · Aug 28'.",
        },
        why: {
          type: "string",
          description:
            "A sentence or two on what has to happen and what waiting costs.",
        },
        reason: { type: "string", description: "One short line for the user." },
      },
      required: ["group", "status", "label", "what", "why", "reason"],
    },
  },
  {
    name: "propose_update_row",
    description:
      "Propose changing a row on the booking board: its status, its tag, what it is, or the note under it.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The [id] of the board row." },
        status: {
          type: "string",
          enum: BOARD_STATUSES,
          description:
            "done = nothing left to do; you = they have to act; " +
            "wait = waiting on someone else; cc = blocked or a dead end.",
        },
        label: { type: "string", description: "New tag, e.g. Confirmed." },
        what: { type: "string", description: "New description of the thing." },
        why: {
          type: "string",
          description: "Replaces the note under the row in full.",
        },
        reason: { type: "string", description: "One short line for the user." },
      },
      required: ["id", "reason"],
    },
  },
  {
    name: "propose_move_row",
    description:
      "Propose moving a board row into a different group, e.g. into the done group once something is confirmed.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The [id] of the board row." },
        group: {
          type: "string",
          description:
            "The heading of the group to move it under, copied exactly from " +
            "the booking board below.",
        },
        status: {
          type: "string",
          enum: BOARD_STATUSES,
          description:
            "Optional new status to go with the move. A row landing in the " +
            "done group should be 'done'.",
        },
        reason: { type: "string", description: "One short line for the user." },
      },
      required: ["id", "group", "reason"],
    },
  },
  {
    name: "propose_delete_row",
    description:
      "Propose removing a row from the booking board entirely. Something that is now booked should move to the done group instead, so the record stays.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The [id] of the board row." },
        reason: { type: "string", description: "One short line for the user." },
      },
      required: ["id", "reason"],
    },
  },

  /* --- cash and timing rules -------------------------------------------- */

  {
    name: "propose_add_rule",
    description:
      "Propose adding a line to the cash and timing rules at the foot of the sheet. These are the standing facts about the trip: what runs on cash, what closes which day.",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "The rule. One or two sentences. <strong>...</strong> around the " +
            "opening clause matches how the others are written.",
        },
        reason: { type: "string", description: "One short line for the user." },
      },
      required: ["text", "reason"],
    },
  },
  {
    name: "propose_update_rule",
    description: "Propose rewriting one of the cash and timing rules.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The [id] of the rule." },
        text: {
          type: "string",
          description: "Replaces the rule in full, so restate all of it.",
        },
        reason: { type: "string", description: "One short line for the user." },
      },
      required: ["id", "text", "reason"],
    },
  },
  {
    name: "propose_delete_rule",
    description:
      "Propose removing a line from the cash and timing rules, for when it no longer applies.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The [id] of the rule." },
        reason: { type: "string", description: "One short line for the user." },
      },
      required: ["id", "reason"],
    },
  },

  /* --- hotels ----------------------------------------------------------- */

  {
    name: "propose_update_stay",
    description:
      "Propose changing one of the hotels at the top of the sheet: its name, neighbourhood, dates or note. This is the stay itself, not the check-in entry on the day, which is a separate entry with its own id.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The [id] of the stay." },
        name: { type: "string", description: "New hotel name." },
        area: {
          type: "string",
          description: "New neighbourhood, e.g. Higashiyama.",
        },
        dates: {
          type: "string",
          description:
            "The nights there, written as it reads on the card: 'Aug 15 to 18'.",
        },
        note: {
          type: "string",
          description:
            "A line under the dates, e.g. a room type or a confirmation " +
            "number. Empty string removes it.",
        },
        reason: { type: "string", description: "One short line for the user." },
      },
      required: ["id", "reason"],
    },
  },
];

/* ------------------------------------------------------------- streaming -- */

/**
 * One turn against the API. Streams text through onDelta as it arrives and
 * resolves with the assembled content blocks.
 *
 * @param {Array} messages  conversation so far, in API shape
 * @param {(text: string) => void} onDelta
 * @returns {Promise<{content: Array, stop_reason: string}>}
 */
export async function runTurn(messages, onDelta) {
  const key = getApiKey();
  if (!key) throw new Error("No API key set.");

  const res = await fetch(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      // Required for calls made straight from a browser rather than a server.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      stream: true,
      // Adaptive is the only on-mode on Sonnet 5, and is the default. Medium
      // effort keeps it reaching for tools without the latency of high.
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: [
        {
          type: "text",
          text: systemPrompt(new Date().toISOString()),
          // The itinerary is the bulk of the prompt and barely changes, so it
          // caches between turns.
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: TOOLS,
      messages,
    }),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error?.message || "";
    } catch (e) {
      /* non-JSON error body */
    }
    throw new Error(friendlyError(res.status, detail));
  }

  const blocks = [];
  let stopReason = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;

      let ev;
      try {
        ev = JSON.parse(line.slice(5).trim());
      } catch (e) {
        continue;
      }

      switch (ev.type) {
        case "content_block_start":
          blocks[ev.index] = { ...ev.content_block, _json: "" };
          break;

        case "content_block_delta": {
          const b = blocks[ev.index];
          if (!b) break;
          if (ev.delta.type === "text_delta") {
            b.text = (b.text || "") + ev.delta.text;
            onDelta?.(ev.delta.text);
          } else if (ev.delta.type === "input_json_delta") {
            b._json += ev.delta.partial_json;
          } else if (ev.delta.type === "thinking_delta") {
            b.thinking = (b.thinking || "") + ev.delta.thinking;
          } else if (ev.delta.type === "signature_delta") {
            b.signature = (b.signature || "") + ev.delta.signature;
          }
          break;
        }

        case "content_block_stop": {
          const b = blocks[ev.index];
          if (b && b.type === "tool_use") {
            try {
              b.input = b._json ? JSON.parse(b._json) : {};
            } catch (e) {
              b.input = {};
            }
          }
          if (b) delete b._json;
          break;
        }

        case "message_delta":
          stopReason = ev.delta?.stop_reason ?? stopReason;
          break;

        case "error":
          throw new Error(ev.error?.message || "Stream error");
      }
    }
  }

  return { content: blocks.filter(Boolean), stop_reason: stopReason };
}

/**
 * The assistant turn as it should be echoed back on the next request.
 *
 * Thinking blocks are dropped. On Sonnet 5 `display` defaults to "omitted", so
 * they arrive with an empty `thinking` string, and replaying one is rejected
 * with "each thinking block must contain thinking". Keeping them would mean
 * round-tripping the signature perfectly for no benefit — nothing in this chat
 * depends on the model re-reading its own reasoning from a previous turn.
 *
 * Empty text blocks go too: a turn that was pure thinking leaves a `{type:
 * "text", text: ""}` behind, and an empty content array is also a 400, so the
 * caller has to check for that.
 */
export function replayable(content) {
  return content
    .filter((b) => b.type === "text" || b.type === "tool_use")
    .filter((b) => b.type !== "text" || (b.text && b.text.trim()))
    .map((b) =>
      b.type === "tool_use"
        ? { type: "tool_use", id: b.id, name: b.name, input: b.input || {} }
        : { type: "text", text: b.text }
    );
}

function friendlyError(status, detail) {
  if (status === 401) return "That API key was rejected. Check it in settings.";
  if (status === 403) return "That key is not allowed to use this model.";
  if (status === 429) return "Rate limited — give it a few seconds.";
  if (status === 400 && /credit|balance/i.test(detail))
    return "The account is out of credit.";
  if (status >= 500) return "Anthropic is having a moment. Try again.";
  return detail || `Request failed (${status}).`;
}

/* --------------------------------------------------------------- summary -- */

const stripTags = (s) => String(s || "").replace(/<[^>]+>/g, "");

/* Every proposal card reads the same way: a heading naming the thing it
   touches, and a few key/value rows. What differs is only where the thing is
   looked up, so the lookups live together here. */

export const findEvent = (id) =>
  (state.data.events || []).find((x) => x.id === id) || null;

export const findPlace = (id) =>
  (state.data.places?.items || []).find((x) => x.id === id) || null;

export function findRow(id) {
  for (const g of state.data.board?.groups || []) {
    const row = (g.rows || []).find((r) => r.id === id);
    if (row) return { row, heading: g.heading };
  }
  return null;
}

export const findRule = (id) =>
  (state.data.rules?.items || []).find((x) => x.id === id) || null;

export const findLeg = (id) =>
  (state.data.legs || []).find((x) => x.id === id) || null;

/** What a saved spot's tags say about it, for the card. */
function placeState(p) {
  if (p.date) return `on ${p.date}`;
  const b = (state.data.places?.buckets || []).find((x) => x.key === p.bucket);
  return b ? b.label : "no day";
}

/** Human-readable one-liner for a proposal card's heading. */
export function describeProposal(name, input) {
  const named = (thing, field) =>
    thing ? `“${thing[field]}”` : `“${input.id}”`;

  switch (name) {
    case "propose_add":
      return `Add “${input.title}”`;
    case "propose_move":
      return `Move ${named(findEvent(input.id), "title")}`;
    case "propose_update":
      return `Edit ${named(findEvent(input.id), "title")}`;
    case "propose_delete":
      return `Delete ${named(findEvent(input.id), "title")}`;

    case "propose_add_place":
      return `Save “${input.name}” to Raquel's Map`;
    case "propose_update_place":
      return `Edit ${named(findPlace(input.id), "name")} on Raquel's Map`;
    case "propose_delete_place":
      return `Remove ${named(findPlace(input.id), "name")} from Raquel's Map`;

    case "propose_add_row":
      return `Add “${input.what}” to the board`;
    case "propose_update_row":
      return `Edit ${named(findRow(input.id)?.row, "what")} on the board`;
    case "propose_move_row":
      return `Move ${named(findRow(input.id)?.row, "what")} on the board`;
    case "propose_delete_row":
      return `Remove ${named(findRow(input.id)?.row, "what")} from the board`;

    case "propose_add_rule":
      return "Add a cash and timing rule";
    case "propose_update_rule":
      return "Rewrite a cash and timing rule";
    case "propose_delete_rule":
      return "Remove a cash and timing rule";

    case "propose_update_stay":
      return `Edit ${named(findLeg(input.id), "name")}`;

    default:
      return "Change the itinerary";
  }
}

/* The labels on the left of a card's rows. Anything not named here shows the
   field name itself, which is fine for the plain ones. */
const FIELD_LABELS = {
  timeHard: "Fixed time",
  cat: "Category",
  what: "Item",
  why: "Note",
  query: "Maps search",
  tentative: "Unconfirmed",
  sort: "Position",
};

const fieldLabel = (k) => FIELD_LABELS[k] || k;

const SKIP = new Set(["id", "reason"]);

/** One row per field the model actually set, in the order it set them. An
 *  empty string means "leave it alone" everywhere except the few fields that
 *  document it as a clear, which is exactly how the apply handlers read it. */
function changedFields(input, { format = {}, clearable = new Set() } = {}) {
  const out = [];
  for (const [k, v] of Object.entries(input)) {
    if (SKIP.has(k) || v === undefined) continue;
    if (v === "") {
      if (clearable.has(k)) out.push([fieldLabel(k), "(cleared)"]);
      continue;
    }
    out.push([fieldLabel(k), format[k] ? format[k](v) : String(v)]);
  }
  return out;
}

const pillsText = (pills) =>
  Array.isArray(pills) && pills.length
    ? pills.map((p) => p.text).join(", ")
    : "";

const pillsRow = (pills) => pillsText(pills) || "(cleared)";

/** The specific lines shown inside a proposal card. */
export function proposalDetails(name, input) {
  const out = [];
  const day = (iso) => {
    try {
      return `${weekday(iso)} ${dayNumber(iso)} Aug`;
    } catch (e) {
      return iso;
    }
  };
  if (name === "propose_add") {
    out.push(["When", `${day(input.date)}${input.time ? `, ${input.time}` : ""}`]);
    out.push(["Type", `${input.kicker} · ${input.cat}`]);
    out.push(["Status", input.status]);
    if (input.place) out.push(["Address", input.place]);
    if (input.note) out.push(["Note", input.note]);
    if (pillsText(input.pills)) out.push(["Tags", pillsText(input.pills)]);
  } else if (name === "propose_move") {
    const e = findEvent(input.id);
    if (e) out.push(["From", `${day(e.date)}${e.time ? `, ${e.time}` : ""}`]);
    out.push(["To", `${day(input.date)}${input.time ? `, ${input.time}` : ""}`]);
  } else if (name === "propose_update") {
    out.push(...changedFields(input, { format: { pills: pillsRow } }));
  } else if (name === "propose_delete") {
    const e = findEvent(input.id);
    if (e) out.push(["Currently", `${day(e.date)}${e.time ? `, ${e.time}` : ""}`]);

    /* --- saved spots --- */
  } else if (name === "propose_add_place") {
    out.push(["What", `${input.kind} · ${input.cat}`]);
    out.push(["Where", [input.area, input.city].filter(Boolean).join(" · ")]);
    out.push([
      "Day",
      input.date ? day(input.date) : "no day, saved to the list",
    ]);
    if (input.note) out.push(["Note", input.note]);
  } else if (name === "propose_update_place") {
    const p = findPlace(input.id);
    if (p) out.push(["Currently", placeState(p)]);
    out.push(
      ...changedFields(input, {
        format: { date: day },
        clearable: new Set(["closed"]),
      })
    );
  } else if (name === "propose_delete_place") {
    const p = findPlace(input.id);
    if (p) {
      out.push(["What", `${p.kind} · ${[p.area, p.city].filter(Boolean).join(", ")}`]);
      out.push(["Currently", placeState(p)]);
    }

    /* --- the booking board --- */
  } else if (name === "propose_add_row") {
    out.push(["Group", input.group]);
    out.push(["Tag", `${input.label} · ${input.status}`]);
    out.push(["Note", input.why]);
  } else if (name === "propose_update_row") {
    const at = findRow(input.id);
    if (at) out.push(["Group", at.heading]);
    out.push(...changedFields(input));
  } else if (name === "propose_move_row") {
    const at = findRow(input.id);
    if (at) out.push(["From", at.heading]);
    out.push(["To", input.group]);
    if (input.status) out.push(["Status", input.status]);
  } else if (name === "propose_delete_row") {
    const at = findRow(input.id);
    if (at) {
      out.push(["Group", at.heading]);
      out.push(["Tag", `${at.row.label} · ${at.row.status}`]);
    }

    /* --- rules --- */
  } else if (name === "propose_add_rule") {
    out.push(["Rule", stripTags(input.text)]);
  } else if (name === "propose_update_rule") {
    const r = findRule(input.id);
    if (r) out.push(["Now", stripTags(r.text)]);
    out.push(["Becomes", stripTags(input.text)]);
  } else if (name === "propose_delete_rule") {
    const r = findRule(input.id);
    if (r) out.push(["Rule", stripTags(r.text)]);

    /* --- hotels --- */
  } else if (name === "propose_update_stay") {
    const l = findLeg(input.id);
    if (l) out.push(["Currently", l.meta || ""]);
    out.push(...changedFields(input, { clearable: new Set(["note"]) }));
  }

  return out;
}

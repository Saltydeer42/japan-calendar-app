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

import { state } from "./store.js";
import { eachDate, weekday, dayNumber, eventsOn } from "./render.js";

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
    d.legs.forEach((l) => lines.push(`- ${l.name} — ${l.meta}`));
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
  }

  if (d.board?.groups?.length) {
    lines.push(`\n## Booking board`);
    for (const g of d.board.groups) {
      lines.push(`\n### ${g.heading}`);
      for (const r of g.rows) {
        lines.push(
          `- [${r.label}] ${r.what} — ${r.why.replace(/<[^>]+>/g, "")}`
        );
      }
    }
  }

  if (d.rules?.items?.length) {
    lines.push(`\n## Cash and timing rules`);
    d.rules.items.forEach((i) => lines.push(`- ${i.replace(/<[^>]+>/g, "")}`));
  }

  return lines.join("\n");
}

function systemPrompt(nowISO) {
  const who = state.data.trip.travellers;
  const travellers = who ? ` The travellers are ${who}.` : "";
  return `You are the trip assistant for a two-person holiday in Japan, 14–30 August 2026. You live inside the travellers' own trip app, in a chat that looks like iMessage.${travellers}

Right now it is ${nowISO}. All trip times are Japan Standard Time.

# What you can and cannot do
You can answer anything about the itinerary below, and you can PROPOSE changes to it using your tools. You cannot make real reservations — you have no phone, no email and no booking integrations. If something needs an actual booking, say who has to do it (them, or a hotel concierge) and offer to add it to the itinerary as a to-book item.

Your tools only ever propose. A card appears in the chat and the user taps to confirm. So never say "done", "added", or "moved" — say what you're proposing and let the card speak. After calling a tool, keep your reply to a single short line; the card carries the detail.

# How to answer
Write like a text message, not a report. One to three sentences is usually right. No headers, no bullet lists, no markdown formatting — this is a chat bubble. Lead with the answer: the place, the time and the neighbourhood, then any caveat. Do not build up to it.

Be concrete and use what you know. If asked where dinner is tonight, name the place, the time and the neighbourhood. If something is tentative or unbooked, say so — the difference between locked and tentative matters a lot to them.

Never invent an address, a reservation number, an opening time, or a train time. If it isn't below, say you don't have it. Guessing a restaurant's closing time is worse than useless to someone standing outside it.

# The itinerary

${itineraryText()}`;
}

/* ----------------------------------------------------------------- tools -- */

const DATE_DESC =
  "Date as YYYY-MM-DD. Must fall inside the trip, 2026-08-14 to 2026-08-30.";

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
        note: { type: "string", description: "A sentence of useful detail." },
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
      "Propose changing fields on an existing entry — its time, status, note, address, or title.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The [id] of the entry." },
        title: { type: "string" },
        time: { type: "string" },
        timeHard: { type: "boolean" },
        status: { type: "string", enum: ["locked", "tentative", "todo"] },
        kicker: { type: "string" },
        place: { type: "string" },
        note: { type: "string" },
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

/** Human-readable one-liner for a proposal card's heading. */
export function describeProposal(name, input) {
  const target = () => {
    const e = state.data.events.find((x) => x.id === input.id);
    return e ? e.title : input.id;
  };
  switch (name) {
    case "propose_add":
      return `Add “${input.title}”`;
    case "propose_move":
      return `Move “${target()}”`;
    case "propose_update":
      return `Edit “${target()}”`;
    case "propose_delete":
      return `Delete “${target()}”`;
    default:
      return "Change the itinerary";
  }
}

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
  } else if (name === "propose_move") {
    const e = state.data.events.find((x) => x.id === input.id);
    if (e) out.push(["From", `${day(e.date)}${e.time ? `, ${e.time}` : ""}`]);
    out.push(["To", `${day(input.date)}${input.time ? `, ${input.time}` : ""}`]);
  } else if (name === "propose_update") {
    const skip = new Set(["id", "reason"]);
    for (const [k, v] of Object.entries(input)) {
      if (skip.has(k) || v === undefined || v === "") continue;
      out.push([k === "timeHard" ? "Fixed time" : k, String(v)]);
    }
  } else if (name === "propose_delete") {
    const e = state.data.events.find((x) => x.id === input.id);
    if (e) out.push(["Currently", `${day(e.date)}${e.time ? `, ${e.time}` : ""}`]);
  }
  return out;
}

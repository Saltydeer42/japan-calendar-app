/* ==========================================================================
   chat.js — the message thread.

   Two transcripts are kept side by side: `ui` is what gets drawn, `api` is the
   exact shape the Messages API wants (tool_use / tool_result blocks and all).
   Keeping them separate avoids reconstructing API state from rendered HTML.
   ========================================================================== */

import {
  runTurn,
  getApiKey,
  setApiKey,
  clearApiKey,
  describeProposal,
  proposalDetails,
} from "./agent.js";
import {
  state,
  upsertEvent,
  deleteEvent,
  nextSortFor,
  makeId,
} from "./store.js";
import { haptic, hasRealHaptics, hapticsOn, setHaptics } from "./haptics.js";
import { esc } from "./render.js";

const el = (id) => document.getElementById(id);
const STORE_KEY = "jc.chat";
const MAX_TOOL_ROUNDS = 4;
const TAPBACKS = ["❤️", "👍", "👎", "😂", "‼️", "❓"];

let ui = [];       // rendered messages
let api = [];      // API-shaped transcript
let busy = false;
let onChanged = () => {};

/* ---------------------------------------------------------- persistence -- */

function save() {
  try {
    // Cap the history so a long trip doesn't blow out localStorage or the
    // per-request token bill.
    const trimmedUi = ui.slice(-60);
    const trimmedApi = api.slice(-60);
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ ui: trimmedUi, api: trimmedApi })
    );
  } catch (e) {
    /* quota — the thread is not precious */
  }
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    ui = raw.ui || [];
    api = raw.api || [];
  } catch (e) {
    ui = [];
    api = [];
  }
  // Rebuild the pending map, or a card left un-tapped before the app was
  // closed would look live and then quietly refuse to apply.
  for (const m of ui) {
    for (const p of m.proposals || []) {
      if (p.status === "pending") pending.set(p.id, { name: p.name, input: p.input });
    }
  }
}

/* ------------------------------------------------------------- rendering -- */

function timeLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return `Today ${timeLabel(iso)}`;
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

/** Message text -> HTML. Escapes everything, then linkifies bare URLs. */
function body(text) {
  return esc(text)
    .replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener">$1</a>'
    )
    .replace(/\n/g, "<br>");
}

function proposalHtml(p) {
  const rows = proposalDetails(p.name, p.input)
    .map(
      ([k, v]) =>
        `<div class="prow"><span class="pk">${esc(k)}</span><span class="pv">${esc(v)}</span></div>`
    )
    .join("");

  const actions =
    p.status === "pending"
      ? `<div class="pacts">
           <button class="pbtn ghost" data-dismiss="${esc(p.id)}">Not now</button>
           <button class="pbtn go" data-apply="${esc(p.id)}">${
            p.name === "propose_delete" ? "Delete" : "Confirm"
          }</button>
         </div>`
      : `<div class="pdone ${p.status}">${
          p.status === "applied" ? "Applied to the trip" : "Dismissed"
        }</div>`;

  return `<div class="prop ${p.status}" data-prop="${esc(p.id)}">
    <div class="phead">${esc(describeProposal(p.name, p.input))}</div>
    ${p.input.reason ? `<div class="pwhy">${esc(p.input.reason)}</div>` : ""}
    ${rows ? `<div class="prows">${rows}</div>` : ""}
    ${actions}
  </div>`;
}

function messageHtml(m, prev, next) {
  const mine = m.role === "user";
  const startsGroup = !prev || prev.role !== m.role;
  const endsGroup = !next || next.role !== m.role;

  const cls = [
    "msg",
    mine ? "me" : "them",
    startsGroup ? "first" : "",
    endsGroup ? "last" : "",
    m.reaction ? "reacted" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const stamp =
    !prev || new Date(m.at) - new Date(prev.at) > 15 * 60 * 1000
      ? `<div class="stamp">${esc(dayLabel(m.at))}</div>`
      : "";

  const bubble = m.text
    ? `<div class="bubble" data-msg="${esc(m.id)}">${body(m.text)}${
        m.reaction ? `<span class="tapback">${m.reaction}</span>` : ""
      }</div>`
    : "";

  const props = (m.proposals || []).map(proposalHtml).join("");
  const err = m.error ? `<div class="msgerr">${esc(m.error)}</div>` : "";

  return `${stamp}<div class="${cls}">${bubble}${props}${err}</div>`;
}

function render() {
  const box = el("thread");
  if (!ui.length) {
    box.innerHTML = `<div class="chatempty">
      <div class="ce-icon">🗾</div>
      <p>Ask about the trip — where dinner is tonight, what's still unbooked,
      what's nearby tonight. Or tell me to move something and I'll put a card up
      for you to confirm.</p>
    </div>`;
    return;
  }
  box.innerHTML = ui
    .map((m, i) => messageHtml(m, ui[i - 1], ui[i + 1]))
    .join("");
}

function scrollDown(smooth = true) {
  const box = el("thread");
  box.scrollTo({ top: box.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

function setTyping(on) {
  el("typing").classList.toggle("on", on);
  if (on) scrollDown();
}

/* ------------------------------------------------------------ proposals -- */

const pending = new Map(); // proposal id -> {name, input}

function applyProposal(pid) {
  const p = pending.get(pid);
  if (!p) return false;
  const { name, input } = p;

  if (name === "propose_add") {
    const date = input.date;
    upsertEvent({
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
    });
    return true;
  }

  const existing = state.data.events.find((e) => e.id === input.id);
  if (!existing) return false;

  if (name === "propose_delete") {
    deleteEvent(existing.id);
    return true;
  }

  if (name === "propose_move") {
    const next = { ...existing, date: input.date };
    if (input.time) next.time = input.time;
    if (existing.date !== input.date) next.sort = nextSortFor(input.date);
    upsertEvent(next);
    return true;
  }

  if (name === "propose_update") {
    const next = { ...existing };
    for (const k of [
      "title",
      "time",
      "timeHard",
      "status",
      "kicker",
      "place",
      "note",
    ]) {
      if (input[k] !== undefined && input[k] !== "") next[k] = input[k];
    }
    if (input.title) next.label = input.title;
    upsertEvent(next);
    return true;
  }

  return false;
}

function markProposal(pid, status) {
  for (const m of ui) {
    for (const p of m.proposals || []) {
      if (p.id === pid) p.status = status;
    }
  }
}

/* ----------------------------------------------------------------- send -- */

function push(role, text, extra = {}) {
  const m = {
    id: `m${Date.now()}${Math.round(performance.now() * 1000) % 1000}`,
    role,
    text,
    at: new Date().toISOString(),
    reaction: null,
    proposals: [],
    ...extra,
  };
  ui.push(m);
  return m;
}

async function send(text) {
  if (busy || !text.trim()) return;
  busy = true;
  el("chatsend").disabled = true;

  push("user", text.trim());
  api.push({ role: "user", content: text.trim() });
  render();
  scrollDown();
  haptic("light");
  save();

  setTyping(true);

  try {
    let rounds = 0;
    while (true) {
      let bubble = null;
      let streamed = "";

      const { content, stop_reason } = await runTurn(api, (delta) => {
        streamed += delta;
        if (!bubble) {
          setTyping(false);
          bubble = push("assistant", "");
          render();
        }
        bubble.text = streamed;
        // Cheap targeted update — full re-render on every token would thrash.
        const node = document.querySelector(`[data-msg="${bubble.id}"]`);
        if (node) node.innerHTML = body(streamed);
        scrollDown(false);
      });

      api.push({ role: "assistant", content });

      const tools = content.filter((b) => b.type === "tool_use");

      if (tools.length) {
        setTyping(false);
        const host = bubble || push("assistant", "");
        host.proposals = host.proposals || [];
        for (const t of tools) {
          const pid = t.id;
          pending.set(pid, { name: t.name, input: t.input });
          host.proposals.push({
            id: pid,
            name: t.name,
            input: t.input,
            status: "pending",
          });
        }
        render();
        scrollDown();
        haptic("medium");
        save();

        if (++rounds > MAX_TOOL_ROUNDS) break;

        api.push({
          role: "user",
          content: tools.map((t) => ({
            type: "tool_result",
            tool_use_id: t.id,
            content:
              "The proposal card is now showing in the chat. It has NOT been applied — the user must tap Confirm. Do not tell them it is done. Reply with one short line only.",
          })),
        });
        setTyping(true);
        continue;
      }

      if (!bubble && !streamed) {
        // Model returned nothing renderable (e.g. thinking only).
        push("assistant", "…");
      }
      break;
    }
  } catch (err) {
    setTyping(false);
    push("assistant", "", { error: err.message || String(err) });
    haptic("error");
  }

  setTyping(false);
  busy = false;
  el("chatsend").disabled = false;
  render();
  scrollDown();
  save();
}

/* ------------------------------------------------------------ tapbacks --- */

let holdTimer = null;
let holdTarget = null;

function openTapbacks(bubbleNode) {
  const bar = el("tapbar");
  const r = bubbleNode.getBoundingClientRect();
  bar.innerHTML = TAPBACKS.map(
    (e) => `<button class="tb" data-tb="${e}">${e}</button>`
  ).join("");
  bar.classList.add("on");

  // Clamp so the bar never runs off either edge.
  const w = Math.min(300, window.innerWidth - 24);
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(12, Math.min(left, window.innerWidth - w - 12));
  bar.style.width = `${w}px`;
  bar.style.left = `${left}px`;
  bar.style.top = `${Math.max(70, r.top - 62)}px`;

  holdTarget = bubbleNode.dataset.msg;
  haptic("heavy");
}

function closeTapbacks() {
  el("tapbar").classList.remove("on");
  holdTarget = null;
}

/* ------------------------------------------------------------------ init - */

export function initChat({ onItineraryChanged }) {
  onChanged = onItineraryChanged || (() => {});
  load();
  render();

  const input = el("chatinput");

  const grow = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  };

  input.addEventListener("input", grow);

  el("chatsend").addEventListener("click", () => {
    const v = input.value;
    input.value = "";
    grow();
    send(v);
  });

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      const v = input.value;
      input.value = "";
      grow();
      send(v);
    }
  });

  // --- proposal cards -----------------------------------------------------
  el("thread").addEventListener("click", (ev) => {
    const applyId = ev.target.closest("[data-apply]")?.dataset.apply;
    const dropId = ev.target.closest("[data-dismiss]")?.dataset.dismiss;

    if (applyId) {
      const ok = applyProposal(applyId);
      markProposal(applyId, ok ? "applied" : "dismissed");
      haptic(ok ? "success" : "warning");
      render();
      save();
      if (ok) onChanged();
      return;
    }
    if (dropId) {
      markProposal(dropId, "dismissed");
      haptic("light");
      render();
      save();
    }
  });

  // --- press and hold for a tapback ---------------------------------------
  el("thread").addEventListener("pointerdown", (ev) => {
    const bubble = ev.target.closest(".bubble");
    if (!bubble) return;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => openTapbacks(bubble), 380);
  });

  const cancelHold = () => clearTimeout(holdTimer);
  el("thread").addEventListener("pointermove", cancelHold);
  el("thread").addEventListener("pointerup", cancelHold);
  el("thread").addEventListener("pointercancel", cancelHold);
  el("thread").addEventListener("scroll", cancelHold);

  el("tapbar").addEventListener("click", (ev) => {
    const pick = ev.target.closest("[data-tb]")?.dataset.tb;
    if (!pick || !holdTarget) return;
    const m = ui.find((x) => x.id === holdTarget);
    if (m) m.reaction = m.reaction === pick ? null : pick;
    haptic("rigid");
    closeTapbacks();
    render();
    save();
  });

  document.addEventListener("pointerdown", (ev) => {
    if (!ev.target.closest("#tapbar") && !ev.target.closest(".bubble")) {
      closeTapbacks();
    }
  });

  // --- settings -----------------------------------------------------------
  el("chatclear").addEventListener("click", () => {
    ui = [];
    api = [];
    pending.clear();
    save();
    render();
    haptic("light");
  });

  const hapToggle = el("haptoggle");
  hapToggle.setAttribute("aria-checked", String(hapticsOn()));
  hapToggle.addEventListener("click", () => {
    const on = hapToggle.getAttribute("aria-checked") !== "true";
    hapToggle.setAttribute("aria-checked", String(on));
    setHaptics(on);
    if (on) haptic("medium");
  });

  el("hapnote").textContent = hasRealHaptics()
    ? "Full Taptic Engine — you're in the native app."
    : "Safari can only manage a weak buzz. Install the native app for the real thing.";

  el("keyclear").addEventListener("click", () => {
    clearApiKey();
    el("chatgate").classList.remove("hidden");
    el("chatmain").classList.add("hidden");
  });

  // --- first-run key gate -------------------------------------------------
  const gated = !getApiKey();
  el("chatgate").classList.toggle("hidden", !gated);
  el("chatmain").classList.toggle("hidden", gated);

  el("keysave").addEventListener("click", () => {
    const v = el("keyin").value.trim();
    if (!v.startsWith("sk-ant-")) {
      el("keyerr").textContent = "That doesn't look like an Anthropic key.";
      el("keyerr").classList.add("on");
      return;
    }
    setApiKey(v);
    el("keyerr").classList.remove("on");
    el("chatgate").classList.add("hidden");
    el("chatmain").classList.remove("hidden");
    haptic("success");
    el("chatinput").focus();
  });
}

export function chatReady() {
  return !!getApiKey();
}

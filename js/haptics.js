/* ==========================================================================
   haptics.js — taptic feedback, by whatever route is actually available.

   Three tiers, best first:

   1. The native wrapper posts to a WKWebView message handler, which drives
      UIImpactFeedbackGenerator. Real Taptic Engine, correct weights.
   2. Safari on iOS has no vibration API at all -- navigator.vibrate is a no-op.
      But toggling a `<input type="checkbox" switch>` fires the system haptic
      as a side effect (iOS 17.4+). It is a hack; it is also the only thing
      that works in a home-screen PWA.
   3. Everywhere else, navigator.vibrate with a pattern per style.

   So: install the native app if you want this to feel right.
   ========================================================================== */

const NATIVE = window.webkit?.messageHandlers?.haptic;

/* Durations for the vibrate() fallback, roughly matched to the iOS feels. */
const PATTERNS = {
  light: 8,
  medium: 14,
  heavy: 22,
  soft: 6,
  rigid: 10,
  select: 5,
  success: [12, 60, 24],
  warning: [20, 70, 20],
  error: [26, 50, 26, 50, 26],
};

/* --- the Safari switch trick ---------------------------------------------
   The element has to be in the layout for the haptic to fire, so it cannot be
   display:none. Park it offscreen at zero opacity instead. */
let toggle = null;

function switchElement() {
  if (toggle) return toggle;
  toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.setAttribute("switch", "");
  toggle.setAttribute("aria-hidden", "true");
  toggle.tabIndex = -1;
  toggle.style.cssText =
    "position:fixed;top:-100px;left:-100px;width:1px;height:1px;" +
    "opacity:0;pointer-events:none;appearance:auto";
  document.body.appendChild(toggle);
  return toggle;
}

let switchWorks = null;

function safariHaptic() {
  if (switchWorks === false) return false;
  try {
    const el = switchElement();
    // Feature-detect once: Safari renders `switch` checkboxes with their own
    // appearance, which is the signal the attribute is understood.
    if (switchWorks === null) {
      switchWorks = "switch" in document.createElement("input");
      if (!switchWorks) return false;
    }
    el.checked = !el.checked;
    el.dispatchEvent(new Event("change", { bubbles: false }));
    return true;
  } catch (e) {
    switchWorks = false;
    return false;
  }
}

/* ------------------------------------------------------------------------ */

let enabled = localStorage.getItem("jc.haptics") !== "off";

export function setHaptics(on) {
  enabled = on;
  localStorage.setItem("jc.haptics", on ? "on" : "off");
}

export function hapticsOn() {
  return enabled;
}

/**
 * @param {"light"|"medium"|"heavy"|"soft"|"rigid"|"select"|"success"|"warning"|"error"} style
 */
export function haptic(style = "light") {
  if (!enabled) return;

  if (NATIVE) {
    try {
      NATIVE.postMessage(style);
      return;
    } catch (e) {
      /* fall through to the web routes */
    }
  }

  if (safariHaptic()) return;

  if (navigator.vibrate) {
    try {
      navigator.vibrate(PATTERNS[style] ?? PATTERNS.light);
    } catch (e) {
      /* some browsers throw on gesture-less vibrate; nothing to do */
    }
  }
}

/** True when we have the real Taptic Engine rather than a fallback. */
export function hasRealHaptics() {
  return !!NATIVE;
}

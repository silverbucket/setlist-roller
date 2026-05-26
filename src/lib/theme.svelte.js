// SYNC: key + resolution logic duplicated in index.html inline script to avoid FOITC
const STORAGE_KEY = "setlist-roller-theme";
const PREFS = ["system", "light", "dark"];
const mq =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : { matches: false };

function readPref() {
  try {
    if (typeof localStorage === "undefined") return "system";
    const v = localStorage.getItem(STORAGE_KEY);
    return PREFS.includes(v) ? v : "system";
  } catch {
    return "system";
  }
}

function resolve(pref) {
  if (pref === "dark" || pref === "light") return pref;
  return mq.matches ? "dark" : "light";
}

function apply(eff) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = eff;
}

let preference = $state(readPref());
let effective = $state(resolve(preference));

apply(effective);

function onSystemChange() {
  if (preference === "system") {
    effective = resolve("system");
    apply(effective);
  }
}

if (typeof mq.addEventListener === "function") {
  mq.addEventListener("change", onSystemChange);
} else if (typeof mq.addListener === "function") {
  mq.addListener(onSystemChange);
}
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (typeof mq.removeEventListener === "function") {
      mq.removeEventListener("change", onSystemChange);
    } else if (typeof mq.removeListener === "function") {
      mq.removeListener(onSystemChange);
    }
  });
}

export function getThemePreference() {
  return preference;
}

export function getEffectiveTheme() {
  return effective;
}

export function setThemePreference(pref) {
  if (!PREFS.includes(pref)) return;
  preference = pref;
  effective = resolve(pref);
  try { localStorage.setItem(STORAGE_KEY, pref); } catch {}
  apply(effective);
}

export function cycleTheme() {
  const i = PREFS.indexOf(preference);
  const next = PREFS[(i + 1) % PREFS.length];
  setThemePreference(next);
  return next;
}

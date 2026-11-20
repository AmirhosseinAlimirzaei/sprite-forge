/* App shell: theme, tab routing, global wiring. */

import { $, $$ } from "./lib/ui.js";
import { init as initBg } from "./tabs/bg.js";
import { init as initTrim } from "./tabs/trim.js";
import { init as initResize } from "./tabs/resize.js";
import { init as initCrop } from "./tabs/crop.js";
import { init as initChecker } from "./tabs/checker.js";
import { init as initModels } from "./tabs/models.js";

const TABS = ["bg", "trim", "resize", "crop", "checker", "models"];
const THEME_KEY = "aat.theme";

let currentTab = "bg";

/* -------------------------------------------------------------------- theme */

function readTheme() {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return stored === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme, persist = false) {
  document.documentElement.dataset.theme = theme;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === "light" ? "#f5f3ee" : "#0a0a0c";

  const button = $("#themeToggle");
  if (button) {
    button.setAttribute(
      "aria-label",
      theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
    );
    button.title = theme === "dark" ? "Switch to light theme (T)" : "Switch to dark theme (T)";
  }

  if (persist) {
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* storage may be unavailable */
    }
  }
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light", true);
}

/* --------------------------------------------------------------------- tabs */

function switchTab(name) {
  if (!TABS.includes(name) || name === currentTab) return;
  currentTab = name;

  $$(".tab").forEach((button) => {
    const active = button.dataset.tab === name;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });

  $$(".tab-panel").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
}

function wireTabs() {
  $$(".tab").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });

  document.addEventListener("app:gototab", (event) => switchTab(event.detail));

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-goto]");
    if (target) switchTab(target.dataset.goto);
  });

  // Arrow keys move between tabs when the tab bar has focus.
  $(".tabbar")?.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = TABS.indexOf(currentTab);
    const next = event.key === "ArrowRight" ? (index + 1) % TABS.length : (index - 1 + TABS.length) % TABS.length;
    switchTab(TABS[next]);
    $(`.tab[data-tab="${TABS[next]}"]`)?.focus();
  });
}

/* ------------------------------------------------------------------- global */

function wireGlobal() {
  $("#themeToggle").addEventListener("click", toggleTheme);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "t" && event.key !== "T") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      (target.matches("input, textarea, select") || target.isContentEditable);

    if (typing || document.querySelector("dialog[open]")) return;
    toggleTheme();
  });

  // Dropping a file anywhere else should never navigate the page away.
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());
}

/* --------------------------------------------------------------------- boot */

function boot() {
  applyTheme(readTheme());
  wireTabs();
  wireGlobal();

  initBg();
  initTrim();
  initResize();
  initCrop();
  initChecker();
  initModels();

  switchTab("bg");
  currentTab = "bg";

  $$(".tab").forEach((button) => {
    button.tabIndex = button.dataset.tab === "bg" ? 0 : -1;
  });
}

boot();

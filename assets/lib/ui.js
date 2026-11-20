/* Shared UI helpers: DOM, toast, drag & drop, downloads, compare view. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function uid() {
  return `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function debounce(fn, ms = 120) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* ------------------------------------------------------------------ toast */

let toastTimer = 0;

export function toast(message, ms = 3200) {
  const box = document.getElementById("toast");
  const text = document.getElementById("toastMessage");
  if (!box || !text) return;

  text.textContent = message;
  box.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove("is-visible"), ms);
}

/* --------------------------------------------------------------- formatting */

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  const decimals = index === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[index]}`;
}

export function formatPercent(value) {
  if (value > 0 && value < 0.1) return "<0.1%";
  if (value < 100 && value > 99.9) return ">99.9%";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded.toFixed(Number.isInteger(rounded) ? 0 : 1)}%`;
}

export function formatDims(width, height) {
  if (!width || !height) return "—";
  return `${width} × ${height}`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* ------------------------------------------------------------------ files */

const IMAGE_TYPES = /^image\/(png|jpeg|webp)$/;

export function isImageFile(file) {
  if (!file) return false;
  if (file.type && IMAGE_TYPES.test(file.type)) return true;
  return /\.(png|jpe?g|webp)$/i.test(file.name || "");
}

export function baseName(name) {
  return String(name || "image").replace(/\.[^.]+$/, "");
}

export function extensionFor(format, sourceName = "") {
  switch (format) {
    case "webp": return "webp";
    case "jpeg": return "jpg";
    case "png": return "png";
    case "keep": {
      const match = /\.([^.]+)$/.exec(sourceName || "");
      const ext = (match ? match[1] : "png").toLowerCase();
      return ext === "jpeg" ? "jpg" : ext;
    }
    default: return "png";
  }
}

export function safeFileName(name) {
  return String(name || "image")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "image";
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ------------------------------------------------------------ drag & drop */

function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const found = [];
    const step = () => {
      reader.readEntries((batch) => {
        if (!batch.length) {
          resolve(found);
          return;
        }
        found.push(...batch);
        step();
      }, reject);
    };
    step();
  });
}

async function walkEntry(entry, out) {
  if (!entry) return;

  if (entry.isFile) {
    try {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push(file);
    } catch (error) {
      console.warn("Could not read dropped file", entry.name, error);
    }
    return;
  }

  if (entry.isDirectory) {
    try {
      const children = await readAllEntries(entry.createReader());
      for (const child of children) await walkEntry(child, out);
    } catch (error) {
      console.warn("Could not read dropped folder", entry.name, error);
    }
  }
}

/** Collects files (recursively through folders) from a drop event. */
export async function filesFromDataTransfer(dataTransfer) {
  if (!dataTransfer) return [];

  const items = Array.from(dataTransfer.items || []);
  const entries = items
    .filter((item) => item.kind === "file")
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (entries.length > 0) {
    const files = [];
    for (const entry of entries) await walkEntry(entry, files);
    if (files.length > 0) return files;
  }

  return Array.from(dataTransfer.files || []);
}

/** Turns one or more elements into drop targets. */
export function bindDrop(elements, onFiles) {
  const targets = (Array.isArray(elements) ? elements : [elements]).filter(Boolean);
  let depth = 0;

  const highlight = (on) => {
    targets.forEach((el) => el.classList.toggle("is-drag", on));
  };

  targets.forEach((el) => {
    el.addEventListener("dragenter", (event) => {
      event.preventDefault();
      depth += 1;
      highlight(true);
    });

    el.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });

    el.addEventListener("dragleave", (event) => {
      event.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) highlight(false);
    });

    el.addEventListener("drop", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      depth = 0;
      highlight(false);
      const files = await filesFromDataTransfer(event.dataTransfer);
      if (files.length) onFiles(files);
    });
  });
}

/* -------------------------------------------------------------- compare view */

/**
 * The side-by-side split viewer used by BG Remover, Trimmer and Resizer.
 * Expects the .compare markup: two .compare-layer images inside, one of them
 * wrapped in .compare-after, plus .compare-line, .compare-range and tags.
 */
export class CompareView {
  constructor(rootId) {
    this.root = document.getElementById(rootId);
    this.empty = null;
    this.layers = this.root ? $$(".compare-layer", this.root) : [];
    this.before = this.layers[0] || null;
    this.after = this.layers[1] || null;
    this.afterWrap = this.root ? $(".compare-after", this.root) : null;
    this.line = this.root ? $(".compare-line", this.root) : null;
    this.range = this.root ? $(".compare-range", this.root) : null;
    this.tagAfter = this.root ? $(".compare-tag--after", this.root) : null;
    this.dragged = false;

    /* The original is layered on top and clipped, so a transparent result
       shows the checkerboard instead of the original image behind it. */
    if (this.before) this.before.classList.add("compare-before");

    if (this.range) {
      this.range.addEventListener("input", () => {
        this.dragged = true;
        this.root.style.setProperty("--split", `${this.range.value}%`);
      });
    }
  }

  setSource(url, label = "") {
    if (!this.root || !this.before) return;
    this.root.hidden = false;
    this.root.classList.add("is-single");
    this.before.src = url;
    this.before.alt = label ? `${label} — original` : "Original";
    if (this.after) this.after.removeAttribute("src");
    [this.afterWrap, this.line, this.range, this.tagAfter].forEach((node) => {
      if (node) node.hidden = true;
    });
  }

  setResult(beforeUrl, afterUrl, split = 50) {
    if (!this.root || !this.before || !this.after) return;
    this.root.hidden = false;
    this.root.classList.remove("is-single");
    this.before.src = beforeUrl;
    this.after.src = afterUrl;
    [this.afterWrap, this.line, this.range, this.tagAfter].forEach((node) => {
      if (node) node.hidden = false;
    });

    /* Keep the user's split position once they have moved it. */
    if (!this.dragged) this.setSplit(split);
  }

  setSplit(value) {
    if (!this.root || !this.range) return;
    const next = clamp(Math.round(value), 0, 100);
    this.range.value = String(next);
    this.root.style.setProperty("--split", `${next}%`);
  }

  clear() {
    if (!this.root) return;
    this.root.hidden = true;
    if (this.before) this.before.removeAttribute("src");
    if (this.after) this.after.removeAttribute("src");
  }
}

/* ---------------------------------------------------------------- progress */

export function setProgress(wrap, bar, percent) {
  if (wrap) wrap.hidden = percent <= 0 || percent >= 100;
  if (bar) bar.style.width = `${clamp(percent, 0, 100)}%`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
    return true;
  } catch {
    toast("Could not copy — select the text manually");
    return false;
  }
}

export function goToTab(name) {
  document.dispatchEvent(new CustomEvent("app:gototab", { detail: name }));
}

/* Crop — slice an atlas into icons by drawing a box for each one.
   Saves straight into a chosen folder when the browser supports it, and
   falls back to a ZIP download. */

import { $, toast, downloadBlob, baseName, safeFileName, bindDrop, clamp } from "../lib/ui.js";
import { blobToCanvas } from "../lib/image.js";
import { createZip } from "../lib/zip.js";

let srcW = 0;
let srcH = 0;
let scale = 1;
let dispW = 0;
let dispH = 0;
let atFit = true;
let selection = null;
let drag = null;
let prefix = "crop";
let counter = 0;
let dirHandle = null;
let busy = false;

const saved = [];
const els = {};

export function init() {
  els.panel = $("#panel-crop");
  els.drop = $("#cropDrop");
  els.stage = $("#cropStage");
  els.empty = $("#cropEmpty");
  els.scroll = $("#cropScroll");
  els.wrap = $("#cropWrap");
  els.canvas = $("#cropCanvas");
  els.box = $("#cropBox");
  els.pop = $("#cropPop");
  els.popSize = $("#cropPopSize");
  els.save = $("#cropSave");
  els.cancel = $("#cropCancel");
  els.meta = $("#cropMeta");
  els.count = $("#cropCount");
  els.list = $("#cropList");
  els.reset = $("#cropReset");
  els.zip = $("#cropZip");
  els.folder = $("#cropFolder");
  els.folderNote = $("#cropFolderNote");
  els.stats = $("#cropStats");
  els.zoomIn = $("#cropZoomIn");
  els.zoomOut = $("#cropZoomOut");
  els.zoomFit = $("#cropZoomFit");
  els.file = $("#cropFile");

  if (!els.canvas) return;

  bindDrop([els.drop, els.stage], (files) => loadFile(files[0]));
  els.drop.addEventListener("click", () => els.file.click());
  els.file.addEventListener("change", () => {
    loadFile(els.file.files[0]);
    els.file.value = "";
  });

  els.canvas.addEventListener("pointerdown", onDown);
  els.canvas.addEventListener("pointermove", onMove);
  els.canvas.addEventListener("pointerup", onUp);
  els.canvas.addEventListener("pointercancel", onUp);

  els.save.addEventListener("click", saveSelection);
  els.cancel.addEventListener("click", clearSelection);

  els.zoomIn.addEventListener("click", () => setZoom(scale * 1.5));
  els.zoomOut.addEventListener("click", () => setZoom(scale / 1.5));
  els.zoomFit.addEventListener("click", fitZoom);

  els.folder.addEventListener("click", chooseFolder);
  els.reset.addEventListener("click", reset);
  els.zip.addEventListener("click", saveZip);

  document.addEventListener("keydown", onKey);

  window.addEventListener("resize", () => {
    if (srcW && atFit && !els.panel.hidden) fitZoom();
  });
}

/* ------------------------------------------------------------------- image */

async function loadFile(file) {
  if (!file) return;

  try {
    const { canvas } = await blobToCanvas(file);
    srcW = canvas.width;
    srcH = canvas.height;

    els.canvas.width = srcW;
    els.canvas.height = srcH;
    els.canvas.getContext("2d").drawImage(canvas, 0, 0);

    prefix = safeFileName(baseName(file.name)) || "crop";
    counter = 0;

    els.empty.hidden = true;
    els.scroll.hidden = false;
    els.reset.disabled = false;
    els.zoomIn.disabled = false;
    els.zoomOut.disabled = false;
    els.zoomFit.disabled = false;

    fitZoom();
    toast(`${srcW} × ${srcH} — drag a box around an icon`);
  } catch (error) {
    console.error(error);
    toast("Could not open that image");
  }
}

function fitZoom() {
  if (!srcW) return;

  const box = els.stage.getBoundingClientRect();
  const next = Math.min((box.width - 28) / srcW, (box.height - 28) / srcH);
  setZoom(next, true);
}

function setZoom(next, fit = false) {
  if (!srcW) return;

  scale = clamp(next, 0.05, 8);
  atFit = fit;
  dispW = Math.max(1, Math.round(srcW * scale));
  dispH = Math.max(1, Math.round(srcH * scale));

  els.canvas.style.width = `${dispW}px`;
  els.canvas.style.height = `${dispH}px`;
  els.canvas.style.imageRendering = scale > 1.5 ? "pixelated" : "auto";
  els.wrap.style.width = `${dispW}px`;
  els.wrap.style.height = `${dispH}px`;

  clearSelection();
  updateMeta();
}

function updateMeta() {
  els.meta.textContent = srcW
    ? `${srcW} × ${srcH}  ·  ${Math.round(scale * 100)}%`
    : "No image loaded";
}

/* --------------------------------------------------------------- selection */

function point(event) {
  const rect = els.canvas.getBoundingClientRect();
  return {
    x: clamp(((event.clientX - rect.left) / rect.width) * srcW, 0, srcW),
    y: clamp(((event.clientY - rect.top) / rect.height) * srcH, 0, srcH),
  };
}

function selRect() {
  if (!selection) return { x: 0, y: 0, w: 0, h: 0 };

  const x = Math.round(Math.min(selection.x0, selection.x1));
  const y = Math.round(Math.min(selection.y0, selection.y1));

  return {
    x,
    y,
    w: Math.min(Math.round(Math.abs(selection.x1 - selection.x0)), srcW - x),
    h: Math.min(Math.round(Math.abs(selection.y1 - selection.y0)), srcH - y),
  };
}

function onDown(event) {
  if (!srcW || event.button !== 0) return;

  event.preventDefault();
  clearSelection();
  els.canvas.setPointerCapture(event.pointerId);

  const start = point(event);
  drag = { x0: start.x, y0: start.y };
}

function onMove(event) {
  if (!drag) return;

  const current = point(event);
  selection = { x0: drag.x0, y0: drag.y0, x1: current.x, y1: current.y };
  drawBox();

  const rect = selRect();
  els.meta.textContent = `${srcW} × ${srcH}  ·  ${rect.w} × ${rect.h} px`;
}

function onUp() {
  if (!drag) return;

  drag = null;
  const rect = selRect();

  if (rect.w < 2 || rect.h < 2) {
    clearSelection();
    return;
  }

  els.popSize.textContent = `${rect.w} × ${rect.h}`;
  els.pop.hidden = false;
  positionPop(rect);
  updateStats();
  updateMeta();
}

function drawBox() {
  const rect = selRect();

  els.box.hidden = false;
  els.box.style.left = `${rect.x * scale}px`;
  els.box.style.top = `${rect.y * scale}px`;
  els.box.style.width = `${rect.w * scale}px`;
  els.box.style.height = `${rect.h * scale}px`;
}

function positionPop(rect) {
  const popW = els.pop.offsetWidth || 200;
  const popH = els.pop.offsetHeight || 34;

  let top = (rect.y + rect.h) * scale + 8;
  if (top + popH > dispH) top = Math.max(0, rect.y * scale - popH - 8);

  const left = clamp(rect.x * scale, 0, Math.max(0, dispW - popW));

  els.pop.style.left = `${left}px`;
  els.pop.style.top = `${top}px`;
}

function clearSelection() {
  selection = null;
  drag = null;
  els.box.hidden = true;
  els.pop.hidden = true;
  updateStats();
  updateMeta();
}

function onKey(event) {
  if (!els.panel || els.panel.hidden || els.pop.hidden) return;

  if (event.key === "Enter") {
    event.preventDefault();
    saveSelection();
  } else if (event.key === "Escape") {
    event.preventDefault();
    clearSelection();
  }
}

/* -------------------------------------------------------------------- save */

function nextName() {
  counter += 1;
  return `${prefix}-${String(counter).padStart(3, "0")}.png`;
}

async function saveSelection() {
  if (busy || !selection) return;

  const rect = selRect();
  if (rect.w < 1 || rect.h < 1) return;

  busy = true;
  els.save.disabled = true;

  try {
    const crop = document.createElement("canvas");
    crop.width = rect.w;
    crop.height = rect.h;
    crop.getContext("2d").drawImage(
      els.canvas,
      rect.x,
      rect.y,
      rect.w,
      rect.h,
      0,
      0,
      rect.w,
      rect.h
    );

    const blob = await new Promise((resolve) => crop.toBlob(resolve, "image/png"));
    const name = nextName();

    if (dirHandle) await writeFile(name, blob);

    saved.push({ name, blob, url: URL.createObjectURL(blob), width: rect.w, height: rect.h });
    renderSaved();
    clearSelection();
    toast(dirHandle ? `Saved ${name}` : `${name} ready — use ZIP at the end`);
  } catch (error) {
    console.error(error);
    toast("Could not save that crop");
  } finally {
    busy = false;
    els.save.disabled = false;
  }
}

async function writeFile(name, blob) {
  const handle = await dirHandle.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function chooseFolder() {
  if (typeof window.showDirectoryPicker !== "function") {
    toast("This browser cannot write to a folder — use ZIP instead");
    return;
  }

  try {
    dirHandle = await window.showDirectoryPicker({ id: "crop", mode: "readwrite" });
    els.folderNote.textContent = `Writing into “${dirHandle.name}”.`;
    toast(`Folder: ${dirHandle.name}`);
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error(error);
      toast("Could not open that folder");
    }
  }
}

function renderSaved() {
  els.count.textContent = String(saved.length);
  els.zip.disabled = saved.length === 0;

  const fragment = document.createDocumentFragment();

  for (const item of saved) {
    const row = document.createElement("li");
    row.className = "crop-item";

    const thumb = document.createElement("span");
    thumb.className = "crop-thumb";
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.src = item.url;
    thumb.append(image);

    const name = document.createElement("span");
    name.className = "crop-name";
    name.textContent = item.name;

    const dims = document.createElement("span");
    dims.className = "crop-dims";
    dims.textContent = `${item.width}×${item.height}`;

    row.append(thumb, name, dims);
    fragment.append(row);
  }

  els.list.replaceChildren(fragment);
  els.list.scrollTop = els.list.scrollHeight;
  updateStats();
}

function updateStats() {
  const values = els.stats.querySelectorAll("dd");
  if (values.length < 3) return;

  const rect = selRect();
  values[0].textContent = srcW ? `${srcW} × ${srcH}` : "—";
  values[1].textContent = rect.w > 0 && rect.h > 0 ? `${rect.w} × ${rect.h}` : "—";
  values[2].textContent = String(saved.length);
}

function reset() {
  for (const item of saved) URL.revokeObjectURL(item.url);
  saved.length = 0;
  counter = 0;
  srcW = 0;
  srcH = 0;
  selection = null;
  drag = null;

  els.canvas.width = 1;
  els.canvas.height = 1;
  els.empty.hidden = false;
  els.scroll.hidden = true;
  els.reset.disabled = true;
  els.zoomIn.disabled = true;
  els.zoomOut.disabled = true;
  els.zoomFit.disabled = true;

  clearSelection();
  renderSaved();
  updateMeta();
}

async function saveZip() {
  if (!saved.length) {
    toast("Nothing saved yet");
    return;
  }

  els.zip.disabled = true;

  try {
    const zip = await createZip(saved.map((item) => ({ name: item.name, blob: item.blob })));
    downloadBlob(zip, `${prefix}-crops.zip`);
  } catch (error) {
    console.error(error);
    toast("Could not build the ZIP");
  } finally {
    els.zip.disabled = false;
  }
}

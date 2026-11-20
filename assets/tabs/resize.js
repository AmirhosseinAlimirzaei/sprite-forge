/* Resizer — the seven desktop modes, previewed live in the browser. */

import {
  $,
  $$,
  toast,
  formatBytes,
  setProgress,
  CompareView,
  bindDrop,
  downloadBlob,
  debounce,
  baseName,
  extensionFor,
  safeFileName,
} from "../lib/ui.js";
import { ImageQueue } from "../lib/queue.js";
import { blobToCanvas, resizeToTarget, encodeCanvas } from "../lib/image.js";
import { createZip } from "../lib/zip.js";

const MODE_NOTES = {
  fit: "Scale down to fit W × H. Never enlarges.",
  "fit-up": "Scale to fit W × H, enlarging when needed.",
  canvas: "Fit inside, then centre on a transparent W × H canvas.",
  long: "Longest side becomes Width.",
  short: "Shortest side becomes Width.",
  width: "Width becomes W; height follows.",
  height: "Height becomes H; width follows.",
};

const PRESETS = {
  "128": [128, 128],
  "256": [256, 256],
  "512": [512, 512],
  "1024": [1024, 1024],
  "2048": [2048, 2048],
  "1920x1080": [1920, 1080],
  "1280x720": [1280, 720],
};

let queue = null;
let compare = null;
let running = false;
let previewUrl = null;
let previewToken = 0;

const els = {};

export function init() {
  els.drop = $("#resDrop");
  els.list = $("#resList");
  els.count = $("#resCount");
  els.clear = $("#resClear");
  els.zip = $("#resZip");
  els.stage = $("#resStage");
  els.stageEmpty = $("#resStageEmpty");
  els.working = $("#resWorking");
  els.meta = $("#resMeta");
  els.run = $("#resRun");
  els.download = $("#resDownload");
  els.progressWrap = $("#resProgressWrap");
  els.progress = $("#resProgress");
  els.stats = $("#resStats");

  els.preset = $("#resPreset");
  els.width = $("#resWidth");
  els.height = $("#resHeight");
  els.mode = $("#resMode");
  els.modeNote = $("#resModeNote");
  els.format = $("#resFormat");
  els.qualityField = $("#resQualityField");
  els.quality = $("#resQuality");
  els.qualityOut = $("#resQualityOut");

  els.files = $("#resFiles");
  els.folder = $("#resFolder");
  els.addFolder = $("#resAddFolder");

  queue = new ImageQueue({
    list: els.list,
    count: els.count,
    template: $("#fileTemplate"),
    onSelect: () => {
      renderStage();
      schedulePreview();
    },
    onChange: () => {
      const has = queue.size > 0;
      els.clear.disabled = !has;
      els.zip.disabled = !queue.items.some((item) => item.result);
      els.run.disabled = !has || running;
      if (!has) els.download.disabled = true;
    },
  });

  compare = new CompareView("resCompare");

  bindDrop([els.drop, els.stage], addFiles);
  els.drop.addEventListener("click", () => els.files.click());
  els.files.addEventListener("change", () => {
    addFiles(Array.from(els.files.files || []));
    els.files.value = "";
  });

  els.addFolder.addEventListener("click", () => els.folder.click());
  els.folder.addEventListener("change", () => {
    addFiles(Array.from(els.folder.files || []));
    els.folder.value = "";
  });

  els.clear.addEventListener("click", () => {
    revokePreview();
    queue.clear();
    renderStage();
    toast("Queue cleared");
  });

  els.run.addEventListener("click", runAll);
  els.download.addEventListener("click", downloadSelected);
  els.zip.addEventListener("click", saveAll);

  els.preset.addEventListener("change", () => {
    const preset = PRESETS[els.preset.value];
    if (preset) {
      els.width.value = String(preset[0]);
      els.height.value = String(preset[1]);
    }
    schedulePreview();
  });

  [els.width, els.height].forEach((input) => {
    input.addEventListener("input", () => {
      els.preset.value = "custom";
      schedulePreview();
    });
  });

  els.mode.addEventListener("change", () => {
    els.modeNote.textContent = MODE_NOTES[els.mode.value] || "";
    schedulePreview();
  });

  $$('input[name="res-filter"]').forEach((radio) => {
    radio.addEventListener("change", schedulePreview);
  });

  els.format.addEventListener("change", () => {
    els.qualityField.hidden = !["jpeg", "webp"].includes(els.format.value);
    schedulePreview();
  });

  els.quality.addEventListener("input", () => {
    els.qualityOut.textContent = els.quality.value;
  });

  els.modeNote.textContent = MODE_NOTES.fit;
  renderStage();
}

const schedulePreview = debounce(() => previewSelected(), 240);

function addFiles(files) {
  const added = queue.add(files || []);
  if (added === 0 && files && files.length) toast("No new images were added");
  renderStage();
  schedulePreview();
}

/* ------------------------------------------------------------------ options */

function readOptions() {
  const filter = $('input[name="res-filter"]:checked');
  return {
    width: Math.max(1, Math.min(16384, Number(els.width.value) || 512)),
    height: Math.max(1, Math.min(16384, Number(els.height.value) || 512)),
    mode: els.mode.value,
    smooth: filter ? filter.value !== "pixel" : true,
    format: els.format.value,
    quality: Number(els.quality.value) / 100,
  };
}

function formatFromName(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "jpeg";
  if (ext === "webp") return "webp";
  return "png";
}

/* ------------------------------------------------------------------ preview */

function revokePreview() {
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
}

function renderStage() {
  const item = queue.selected;

  if (!item) {
    compare.clear();
    els.stageEmpty.hidden = false;
    els.meta.textContent = "No image selected";
    els.download.disabled = true;
    els.run.disabled = queue.size === 0 || running;
    revokePreview();
    setStats(null);
    return;
  }

  els.stageEmpty.hidden = true;
  compare.setSource(item.url, item.name);
  els.meta.textContent = `${item.name}  ·  ${item.width && item.height ? `${item.width} × ${item.height}` : "…"}`;
  els.run.disabled = running || queue.size === 0;
  els.download.disabled = !item.result;
}

async function previewSelected() {
  const item = queue.selected;
  if (!item) return;

  const token = ++previewToken;
  const options = readOptions();
  const spinner = window.setTimeout(() => {
    if (token === previewToken) els.working.hidden = false;
  }, 200);

  try {
    const result = await resizeItem(item, options);
    if (token !== previewToken) return;

    revokePreview();
    previewUrl = URL.createObjectURL(result.blob);
    compare.setResult(item.url, previewUrl);

    els.meta.textContent = describe(item, result);
    setStats(result);
  } catch (error) {
    console.error("preview failed", error);
    if (token === previewToken) {
      compare.setSource(item.url, item.name);
      els.meta.textContent = `${item.name} — preview failed`;
    }
  } finally {
    window.clearTimeout(spinner);
    if (token === previewToken) els.working.hidden = true;
  }
}

async function resizeItem(item, options) {
  const { canvas, width, height } = await blobToCanvas(item.file);
  const target = resizeToTarget(canvas, options.width, options.height, options.mode, options.smooth);
  const format = options.format === "keep" ? formatFromName(item.name) : options.format;
  const encoded = await encodeCanvas(target, format, options.quality);

  return {
    blob: encoded.blob,
    format: encoded.format,
    width: target.width,
    height: target.height,
    sourceWidth: width,
    sourceHeight: height,
  };
}

function describe(item, result) {
  return `${item.name}  ·  ${result.sourceWidth} × ${result.sourceHeight} → ${result.width} × ${result.height}`;
}

function setStats(result) {
  const values = els.stats.querySelectorAll("dd");
  if (!values.length) return;

  if (!result) {
    values[0].textContent = "—";
    values[1].textContent = "—";
    values[2].textContent = "—";
    return;
  }

  const scale = result.sourceWidth ? result.width / result.sourceWidth : 1;

  values[0].textContent = `${result.sourceWidth} × ${result.sourceHeight}`;
  values[1].textContent = `${result.width} × ${result.height} · ${formatBytes(result.blob.size)}`;
  values[2].textContent = `${scale.toFixed(2)}×`;
}

/* ---------------------------------------------------------------------- run */

async function runAll() {
  if (running || queue.size === 0) return;

  running = true;
  els.run.disabled = true;
  els.download.disabled = true;
  els.progressWrap.hidden = false;
  setProgress(els.progressWrap, els.progress, 0);

  const options = readOptions();
  const items = queue.items.slice();
  let completed = 0;
  let failures = 0;

  for (const item of items) {
    queue.setState(item.id, "working", "resizing…");

    try {
      const result = await resizeItem(item, options);
      queue.setResult(item.id, {
        blob: result.blob,
        width: result.width,
        height: result.height,
        format: result.format,
      });
      queue.setState(item.id, "done");
    } catch (error) {
      failures += 1;
      queue.setState(item.id, "error", error.message || "failed");
      console.error("resize failed", item.name, error);
    }

    completed += 1;
    setProgress(els.progressWrap, els.progress, (completed / items.length) * 100);
  }

  running = false;
  els.run.disabled = queue.size === 0;
  els.zip.disabled = !queue.items.some((item) => item.result);
  renderStage();
  previewSelected();

  if (failures > 0) toast(`${failures} image${failures === 1 ? "" : "s"} could not be resized`);
  else toast(`Resized ${completed} image${completed === 1 ? "" : "s"}`);
}

/* ----------------------------------------------------------------- download */

function resultName(item) {
  const format = item.result?.format || "png";
  const ext = extensionFor(format === "keep" ? "png" : format, item.name);
  return safeFileName(`${baseName(item.name)}-${item.result?.width || 0}x${item.result?.height || 0}.${ext}`);
}

function downloadSelected() {
  const item = queue.selected;
  if (!item || !item.result) {
    toast("Run “Resize all” first");
    return;
  }
  downloadBlob(item.result.blob, resultName(item));
}

async function saveAll() {
  const ready = queue.items.filter((item) => item.result);
  if (!ready.length) {
    toast("Run “Resize all” first");
    return;
  }

  if (ready.length === 1) {
    downloadBlob(ready[0].result.blob, resultName(ready[0]));
    return;
  }

  els.zip.disabled = true;
  toast(`Packing ${ready.length} images…`);

  try {
    const zip = await createZip(ready.map((item) => ({ name: resultName(item), blob: item.result.blob })));
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    downloadBlob(zip, `resized-${stamp}.zip`);
  } catch (error) {
    console.error(error);
    toast("Could not build the ZIP file");
  } finally {
    els.zip.disabled = false;
  }
}

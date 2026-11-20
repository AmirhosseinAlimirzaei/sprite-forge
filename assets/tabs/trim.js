/* Trimmer — alpha/colour border crop with a live preview, all client-side. */

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
import { blobToCanvas, trimCanvas, encodeCanvas, readPixels } from "../lib/image.js";
import { createZip } from "../lib/zip.js";

let queue = null;
let compare = null;
let running = false;
let previewUrl = null;
let previewToken = 0;

const els = {};

export function init() {
  els.drop = $("#trimDrop");
  els.list = $("#trimList");
  els.count = $("#trimCount");
  els.clear = $("#trimClear");
  els.zip = $("#trimZip");
  els.stage = $("#trimStage");
  els.stageEmpty = $("#trimStageEmpty");
  els.working = $("#trimWorking");
  els.meta = $("#trimMeta");
  els.run = $("#trimRun");
  els.download = $("#trimDownload");
  els.progressWrap = $("#trimProgressWrap");
  els.progress = $("#trimProgress");
  els.stats = $("#trimStats");

  els.alpha = $("#trimAlpha");
  els.alphaOut = $("#trimAlphaOut");
  els.pad = $("#trimPad");
  els.padOut = $("#trimPadOut");
  els.colorEnable = $("#trimColorEnable");
  els.colorOpts = $("#trimColorOpts");
  els.color = $("#trimColor");
  els.colorHex = $("#trimColorHex");
  els.colorPick = $("#trimColorPick");
  els.fuzz = $("#trimFuzz");
  els.fuzzOut = $("#trimFuzzOut");
  els.qualityField = $("#trimQualityField");
  els.quality = $("#trimQuality");
  els.qualityOut = $("#trimQualityOut");

  els.files = $("#trimFiles");
  els.folder = $("#trimFolder");
  els.addFolder = $("#trimAddFolder");

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

  compare = new CompareView("trimCompare");

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

  els.alpha.addEventListener("input", () => {
    els.alphaOut.textContent = els.alpha.value;
    schedulePreview();
  });
  els.pad.addEventListener("input", () => {
    els.padOut.textContent = els.pad.value;
    schedulePreview();
  });
  els.fuzz.addEventListener("input", () => {
    els.fuzzOut.textContent = els.fuzz.value;
    schedulePreview();
  });

  els.colorEnable.addEventListener("change", () => {
    els.colorOpts.classList.toggle("is-disabled", !els.colorEnable.checked);
    schedulePreview();
  });

  els.color.addEventListener("input", () => {
    els.colorHex.value = els.color.value;
    schedulePreview();
  });

  els.colorHex.addEventListener("change", () => {
    const rgb = hexToRgb(els.colorHex.value);
    if (!rgb) {
      els.colorHex.value = els.color.value;
      toast("Use a hex colour like #ffffff");
      return;
    }
    els.color.value = rgb.hex;
    els.colorHex.value = rgb.hex;
    schedulePreview();
  });

  els.colorPick.addEventListener("click", pickCornerColour);

  $$('input[name="trim-format"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      els.qualityField.hidden = readOptions().format !== "webp";
    });
  });

  els.quality.addEventListener("input", () => {
    els.qualityOut.textContent = els.quality.value;
  });

  els.colorOpts.classList.add("is-disabled");
  renderStage();
}

const schedulePreview = debounce(() => previewSelected(), 220);

function addFiles(files) {
  const added = queue.add(files || []);
  if (added === 0 && files && files.length) toast("No new images were added");
  renderStage();
  schedulePreview();
}

/* ------------------------------------------------------------------ options */

function readOptions() {
  const formatInput = $('input[name="trim-format"]:checked');
  const rgb = els.colorEnable.checked ? hexToRgb(els.colorHex.value) : null;

  return {
    threshold: Number(els.alpha.value) || 0,
    padding: Number(els.pad.value) || 0,
    color: rgb ? { r: rgb.r, g: rgb.g, b: rgb.b } : null,
    fuzz: Number(els.fuzz.value) || 0,
    format: formatInput ? formatInput.value : "png",
    quality: Number(els.quality.value) / 100,
  };
}

function hexToRgb(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value).trim());
  if (!match) return null;
  const int = parseInt(match[1], 16);
  const hex = `#${match[1].toLowerCase()}`;
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255, hex };
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
    const result = await trimItem(item, options);
    if (token !== previewToken) return;

    revokePreview();
    previewUrl = URL.createObjectURL(result.blob);
    compare.setResult(item.url, previewUrl);

    els.meta.textContent = describe(item, result);
    els.download.disabled = !item.result;
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

async function trimItem(item, options) {
  const { canvas, width, height } = await blobToCanvas(item.file);
  const trimmed = trimCanvas(canvas, options);
  const encoded = await encodeCanvas(trimmed.canvas, options.format, options.quality);

  return {
    blob: encoded.blob,
    format: encoded.format,
    width: trimmed.canvas.width,
    height: trimmed.canvas.height,
    sourceWidth: width,
    sourceHeight: height,
    applied: trimmed.applied,
  };
}

function describe(item, result) {
  const before = `${result.sourceWidth} × ${result.sourceHeight}`;
  const after = `${result.width} × ${result.height}`;
  return `${item.name}  ·  ${before} → ${after}${result.applied ? "" : "  · no crop"}`;
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

  const before = result.sourceWidth * result.sourceHeight;
  const after = result.width * result.height;
  const saved = before > 0 ? ((1 - after / before) * 100) : 0;

  values[0].textContent = `${result.sourceWidth} × ${result.sourceHeight}`;
  values[1].textContent = `${result.width} × ${result.height} · ${formatBytes(result.blob.size)}`;
  values[2].textContent = `${saved >= 0 ? "" : "+"}${Math.abs(saved).toFixed(1)}% ${saved >= 0 ? "smaller" : "larger"}`;
}

async function pickCornerColour() {
  const item = queue.selected;
  if (!item) {
    toast("Select an image first");
    return;
  }

  try {
    const { canvas } = await blobToCanvas(item.file);
    const { data } = readPixels(canvas);
    const r = data[0];
    const g = data[1];
    const b = data[2];
    const hex = `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;

    els.color.value = hex;
    els.colorHex.value = hex;
    els.colorEnable.checked = true;
    els.colorOpts.classList.remove("is-disabled");
    schedulePreview();
  } catch (error) {
    console.error(error);
    toast("Could not read the pixel");
  }
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
    queue.setState(item.id, "working", "trimming…");

    try {
      const result = await trimItem(item, options);
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
      console.error("trim failed", item.name, error);
    }

    completed += 1;
    setProgress(els.progressWrap, els.progress, (completed / items.length) * 100);
  }

  running = false;
  els.run.disabled = queue.size === 0;
  els.zip.disabled = !queue.items.some((item) => item.result);
  renderStage();
  previewSelected();

  if (failures > 0) toast(`${failures} image${failures === 1 ? "" : "s"} could not be trimmed`);
  else toast(`Trimmed ${completed} image${completed === 1 ? "" : "s"}`);
}

/* ----------------------------------------------------------------- download */

function resultName(item) {
  const ext = extensionFor(item.result?.format || "png");
  return safeFileName(`${baseName(item.name)}-trimmed.${ext}`);
}

function downloadSelected() {
  const item = queue.selected;
  if (!item || !item.result) {
    toast("Run “Trim all” first");
    return;
  }
  downloadBlob(item.result.blob, resultName(item));
}

async function saveAll() {
  const ready = queue.items.filter((item) => item.result);
  if (!ready.length) {
    toast("Run “Trim all” first");
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
    downloadBlob(zip, `trimmed-${stamp}.zip`);
  } catch (error) {
    console.error(error);
    toast("Could not build the ZIP file");
  } finally {
    els.zip.disabled = false;
  }
}

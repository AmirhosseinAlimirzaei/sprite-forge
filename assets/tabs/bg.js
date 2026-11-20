/* BG Remover — the main tab. Sends each image to the local rembg server. */

import {
  $,
  $$,
  toast,
  formatBytes,
  formatDims,
  setProgress,
  CompareView,
  bindDrop,
  downloadBlob,
  baseName,
  extensionFor,
  safeFileName,
} from "../lib/ui.js";
import { ImageQueue } from "../lib/queue.js";
import { onStatus, removeBackground, refreshStatus, getStatus } from "../lib/api.js";
import { blobToCanvas, trimCanvas, encodeCanvas } from "../lib/image.js";
import { MODELS, modelInfo, pickDefaultModel } from "../lib/models.js";
import { createZip } from "../lib/zip.js";

let queue = null;
let compare = null;
let running = false;
let abortController = null;
let engineReady = false;

const els = {};

/* Animation player over the processed frames, in queue order. */
const anim = { frames: [], index: 0, timer: 0, playing: false };

export function init() {
  els.banner = $("#bgBanner");
  els.bannerText = $("#bgBannerText");
  els.drop = $("#bgDrop");
  els.list = $("#bgList");
  els.count = $("#bgCount");
  els.clear = $("#bgClear");
  els.zip = $("#bgZip");
  els.stage = $("#bgStage");
  els.stageEmpty = $("#bgStageEmpty");
  els.compare = $("#bgCompare");
  els.working = $("#bgWorking");
  els.meta = $("#bgMeta");
  els.run = $("#bgRun");
  els.stop = $("#bgStop");
  els.download = $("#bgDownload");
  els.progressWrap = $("#bgProgressWrap");
  els.progress = $("#bgProgress");
  els.model = $("#bgModel");
  els.modelNote = $("#bgModelNote");
  els.matting = $("#bgMatting");
  els.erodeField = $("#bgErodeField");
  els.erode = $("#bgErode");
  els.erodeOut = $("#bgErodeOut");
  els.trim = $("#bgTrim");
  els.padField = $("#bgPadField");
  els.pad = $("#bgPad");
  els.padOut = $("#bgPadOut");
  els.qualityField = $("#bgQualityField");
  els.quality = $("#bgQuality");
  els.qualityOut = $("#bgQualityOut");
  els.stats = $("#bgStats");
  els.files = $("#bgFiles");
  els.folder = $("#bgFolder");
  els.addFolder = $("#bgAddFolder");
  els.animate = $("#bgAnimate");
  els.animDialog = $("#animDialog");
  els.animFrame = $("#animFrame");
  els.animCount = $("#animCount");
  els.animPlay = $("#animPlay");
  els.animSpeed = $("#animSpeed");
  els.animSpeedOut = $("#animSpeedOut");
  els.animLoop = $("#animLoop");
  els.animClose = $("#animClose");

  queue = new ImageQueue({
    list: els.list,
    count: els.count,
    template: $("#fileTemplate"),
    onSelect: () => renderStage(),
    onChange: () => {
      const has = queue.size > 0;
      els.clear.disabled = !has;
      els.zip.disabled = !queue.items.some((item) => item.result);
      if (!has) {
        els.download.disabled = true;
        els.run.disabled = true;
      } else {
        els.run.disabled = running;
      }
    },
  });

  compare = new CompareView("bgCompare");

  bindDrop([els.drop, els.stage], (files) => addFiles(files));

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
    cancel();
    closeAnimation();
    queue.clear();
    els.progressWrap.hidden = true;
    toast("Queue cleared");
  });

  els.run.addEventListener("click", run);
  els.stop.addEventListener("click", cancel);
  els.download.addEventListener("click", downloadSelected);
  els.zip.addEventListener("click", saveAll);

  els.matting.addEventListener("change", () => {
    els.erodeField.hidden = !els.matting.checked;
  });

  els.trim.addEventListener("change", () => {
    els.padField.hidden = !els.trim.checked;
  });

  els.erode.addEventListener("input", () => {
    els.erodeOut.textContent = els.erode.value;
  });

  els.pad.addEventListener("input", () => {
    els.padOut.textContent = els.pad.value;
  });

  $$('input[name="bg-format"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      els.qualityField.hidden = readOptions().format !== "webp";
    });
  });

  els.quality.addEventListener("input", () => {
    els.qualityOut.textContent = els.quality.value;
  });

  els.model.addEventListener("change", updateModelNote);

  document.addEventListener("app:usemodel", (event) => {
    const id = event.detail;
    if (!id) return;
    const known = Array.from(els.model.options).some((option) => option.value === id);
    if (known) {
      els.model.value = id;
      updateModelNote();
    }
  });

  els.animate.addEventListener("click", openAnimation);
  els.animClose.addEventListener("click", closeAnimation);
  els.animDialog.addEventListener("close", stopAnimation);
  els.animDialog.addEventListener("click", (event) => {
    if (event.target === els.animDialog) closeAnimation();
  });
  els.animPlay.addEventListener("click", () => (anim.playing ? pauseAnimation() : playAnimation()));
  els.animSpeed.addEventListener("input", () => {
    els.animSpeedOut.textContent = `${els.animSpeed.value} fps`;
    if (anim.playing) playAnimation();
  });

  onStatus(applyStatus);
  refreshStatus();
  renderStage();
}

function addFiles(files) {
  const added = queue.add(files || []);
  if (added === 0 && files && files.length) {
    toast("No new PNG, JPG or WebP files were added");
  }
  renderStage();
}

function readOptions() {
  const formatInput = $('input[name="bg-format"]:checked');
  return {
    matting: els.matting.checked,
    erode: Number(els.erode.value) || 0,
    trim: els.trim.checked,
    padding: Number(els.pad.value) || 0,
    format: formatInput ? formatInput.value : "png",
    quality: Number(els.quality.value) / 100,
  };
}

/* ------------------------------------------------------------- status/model */

function applyStatus(status) {
  engineReady = Boolean(status?.engine?.rembg);

  els.banner.hidden = engineReady;
  if (!engineReady) {
    const message = status?.engine?.error;
    if (message) els.bannerText.textContent = message;
  }

  if (!els.model.dataset.initialised) {
    els.model.dataset.initialised = "1";
    renderModelOptions(status, true);
  } else {
    renderModelOptions(status, false);
  }
}

function renderModelOptions(status, selectDefault) {
  const installed = new Map((status?.models || []).map((model) => [model.id, model.installed]));
  const previous = els.model.value;

  const ordered = [...MODELS].sort((a, b) => {
    const aReady = installed.get(a.id) ? 1 : 0;
    const bReady = installed.get(b.id) ? 1 : 0;
    if (aReady !== bReady) return bReady - aReady;
    return b.quality - a.quality;
  });

  const fragment = document.createDocumentFragment();

  for (const model of ordered) {
    const option = document.createElement("option");
    option.value = model.id;
    const ready = installed.get(model.id);
    option.textContent = `${model.name} — ${ready ? "ready" : "not downloaded"} · ${model.size}`;
    fragment.append(option);
  }

  els.model.replaceChildren(fragment);

  const target = selectDefault ? pickDefaultModel(status) : previous;
  if (target && ordered.some((model) => model.id === target)) {
    els.model.value = target;
  }

  updateModelNote();
}

function updateModelNote() {
  const status = getStatus();
  const model = els.model.value;
  if (!model) return;

  const installed = (status?.models || []).find((entry) => entry.id === model)?.installed;

  if (!engineReady) {
    els.modelNote.textContent = "Engine unavailable — see the banner above.";
    return;
  }

  if (installed) {
    els.modelNote.textContent = `${modelInfo(model).desc} · downloaded`;
  } else {
    els.modelNote.textContent = `${modelInfo(model).size} download on first run — this can take a while.`;
  }
}

/* ----------------------------------------------------------------- preview */

function renderStage() {
  const item = queue.selected;

  if (!item) {
    compare.clear();
    els.stageEmpty.hidden = false;
    els.working.hidden = true;
    els.meta.textContent = "No image selected";
    els.download.disabled = true;
    els.animate.disabled = true;
    els.run.disabled = queue.size === 0 || running;
    setStats(null, null);
    return;
  }

  els.stageEmpty.hidden = true;

  if (item.result) {
    compare.setResult(item.url, item.result.previewUrl || item.result.url);
  } else {
    compare.setSource(item.url, item.name);
  }

  els.working.hidden = !(running && item.state === "working");

  const sourceDims = item.width && item.height ? formatDims(item.width, item.height) : "";
  const resultDims = item.result ? formatDims(item.result.width, item.result.height) : "";
  const parts = [item.name];
  if (sourceDims && resultDims) parts.push(`${sourceDims} → ${resultDims}`);
  else if (sourceDims) parts.push(sourceDims);
  els.meta.textContent = parts.join("  ·  ");

  els.download.disabled = !item.result;
  els.animate.disabled = queue.items.filter((entry) => entry.result).length < 2 || running;
  els.run.disabled = running || queue.size === 0;

  setStats(item, item.result);
}

function setStats(item, result) {
  const values = els.stats.querySelectorAll("dd");
  if (!values.length) return;

  if (!item) {
    values[0].textContent = "—";
    values[1].textContent = "—";
    values[2].textContent = "—";
    return;
  }

  values[0].textContent = item.width && item.height ? formatDims(item.width, item.height) : "—";
  values[1].textContent = result ? `${formatDims(result.width, result.height)} · ${formatBytes(result.blob.size)}` : "—";
  values[2].textContent = result && item.ms ? `${(item.ms / 1000).toFixed(1)} s` : "—";
}

/* -------------------------------------------------------------------- run */

async function run() {
  if (running || queue.size === 0) return;

  if (!engineReady) {
    els.banner.hidden = false;
    toast("Background removal is not installed on the server");
    return;
  }

  closeAnimation();

  const options = readOptions();
  const model = els.model.value;
  const items = queue.items.slice();

  const modelReady = (getStatus()?.models || []).find((entry) => entry.id === model)?.installed;
  if (!modelReady) {
    toast("First run: downloading this model — this can take a few minutes", 6000);
  }

  running = true;
  abortController = new AbortController();
  els.run.disabled = true;
  els.stop.hidden = false;
  els.progressWrap.hidden = false;
  setProgress(els.progressWrap, els.progress, 0);
  renderStage();

  let completed = 0;
  let failures = 0;

  for (const item of items) {
    if (abortController.signal.aborted) break;

    queue.setState(item.id, "working", "removing…");
    if (item.id === queue.selectedId) renderStage();

    const started = performance.now();

    try {
      const { blob, ms } = await removeBackground(item.file, {
        model,
        matting: options.matting,
        erode: options.erode,
        signal: abortController.signal,
      });

      const result = await finish(blob, options);
      queue.setResult(item.id, result, ms || Math.round(performance.now() - started));
      queue.setState(item.id, "done");
    } catch (error) {
      if (error.name === "AbortError") {
        queue.setState(item.id, "idle");
        break;
      }
      failures += 1;
      queue.setState(item.id, "error", shortError(error));
      console.error("removal failed", item.name, error);
    }

    completed += 1;
    setProgress(els.progressWrap, els.progress, (completed / items.length) * 100);
    if (item.id === queue.selectedId) renderStage();
  }

  const aborted = abortController ? abortController.signal.aborted : false;

  running = false;
  abortController = null;
  els.stop.hidden = true;
  els.run.disabled = queue.size === 0;
  els.zip.disabled = !queue.items.some((item) => item.result);
  if (aborted) setProgress(els.progressWrap, els.progress, 0);
  renderStage();

  if (failures > 0) {
    toast(`${failures} of ${completed} images failed — check the highlighted rows`);
  } else if (completed > 0) {
    toast(`Done — ${completed} cut-out${completed === 1 ? "" : "s"} ready`);
  }
}

/** Applies auto-trim + output format to the raw cut-out. */
async function finish(blob, options) {
  const { canvas } = await blobToCanvas(blob);
  const trimmed = options.trim
    ? trimCanvas(canvas, { threshold: 10, padding: options.padding })
    : { canvas };

  if (!options.trim && options.format === "png") {
    return {
      blob,
      width: canvas.width,
      height: canvas.height,
      format: "png",
    };
  }

  const encoded = await encodeCanvas(trimmed.canvas, options.format, options.quality);
  return {
    blob: encoded.blob,
    /* Preview the untrimmed cut-out so it keeps the original frame; the
       downloaded file is the trimmed one. */
    previewBlob: options.trim ? blob : null,
    width: trimmed.canvas.width,
    height: trimmed.canvas.height,
    format: encoded.format,
  };
}

function cancel() {
  if (abortController) abortController.abort();
}

function shortError(error) {
  const message = String((error && error.message) || error || "failed");
  return message.length > 90 ? `${message.slice(0, 87)}…` : message;
}

/* -------------------------------------------------------------- animation */

function openAnimation() {
  const frames = queue.items.filter((item) => item.result);
  if (frames.length < 2) {
    toast("Process at least two images first");
    return;
  }

  /* Untrimmed previews keep every frame in the same frame size, so the
     character does not jump around when the walk cycle plays. */
  anim.frames = frames.map((item) => item.result.previewUrl || item.result.url);
  anim.index = 0;
  anim.playing = false;

  for (const url of anim.frames) new Image().src = url;

  els.animSpeedOut.textContent = `${els.animSpeed.value} fps`;
  els.animDialog.showModal();
  showFrame(0);
  playAnimation();
}

function showFrame(index) {
  anim.index = index;
  els.animFrame.src = anim.frames[index];
  els.animCount.textContent = `${index + 1} / ${anim.frames.length}`;
}

function playAnimation() {
  clearInterval(anim.timer);
  anim.playing = true;
  els.animPlay.textContent = "Pause";

  const fps = Math.max(1, Number(els.animSpeed.value) || 12);
  anim.timer = setInterval(advanceFrame, 1000 / fps);
}

function pauseAnimation() {
  clearInterval(anim.timer);
  anim.timer = 0;
  anim.playing = false;
  els.animPlay.textContent = "Play";
}

function advanceFrame() {
  const next = anim.index + 1;

  if (next < anim.frames.length) {
    showFrame(next);
    return;
  }

  if (els.animLoop.checked) showFrame(0);
  else pauseAnimation();
}

function closeAnimation() {
  if (els.animDialog.open) els.animDialog.close();
}

function stopAnimation() {
  pauseAnimation();
  anim.frames = [];
  els.animFrame.removeAttribute("src");
}

/* --------------------------------------------------------------- download */

function resultName(item) {
  const ext = extensionFor(item.result?.format || "png");
  return safeFileName(`${baseName(item.name)}-nobg.${ext}`);
}

function downloadSelected() {
  const item = queue.selected;
  if (!item || !item.result) return;
  downloadBlob(item.result.blob, resultName(item));
}

async function saveAll() {
  const ready = queue.items.filter((item) => item.result);
  if (!ready.length) {
    toast("Nothing has been processed yet");
    return;
  }

  if (ready.length === 1) {
    downloadBlob(ready[0].result.blob, resultName(ready[0]));
    return;
  }

  els.zip.disabled = true;
  setProgress(els.progressWrap, els.progress, 5);
  toast(`Packing ${ready.length} images…`);

  try {
    const zip = await createZip(
      ready.map((item) => ({ name: resultName(item), blob: item.result.blob }))
    );
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    downloadBlob(zip, `cutouts-${stamp}.zip`);
  } catch (error) {
    console.error(error);
    toast("Could not build the ZIP file");
  } finally {
    els.zip.disabled = false;
    els.progressWrap.hidden = true;
  }
}

/* Models — engine status and one-click model downloads. */

import { $, toast, formatBytes, copyText } from "../lib/ui.js";
import { onStatus, refreshStatus, warmupModel, revealModelFolder } from "../lib/api.js";
import { MODELS, modelInfo } from "../lib/models.js";

const downloading = new Set();
let poller = 0;

const els = {};

export function init() {
  els.badge = $("#engineBadge");
  els.info = $("#engineInfo");
  els.hint = $("#engineHint");
  els.list = $("#modelList");
  els.count = $("#modelsCount");
  els.refresh = $("#modelsRefresh");
  els.copyPath = $("#modelsCopyPath");
  els.openFolder = $("#modelsOpenFolder");

  if (!els.list) return;

  els.refresh.addEventListener("click", () => {
    toast("Checking the engine…", 1400);
    refreshStatus();
  });

  els.copyPath.addEventListener("click", () => {
    const dir = els.info.querySelectorAll("dd")[2];
    if (dir && dir.textContent !== "—") copyText(dir.textContent);
  });

  els.openFolder.addEventListener("click", async () => {
    try {
      await revealModelFolder();
    } catch (error) {
      console.error(error);
      toast("Could not open the model folder");
    }
  });

  onStatus(render);
}

function render(status) {
  if (!status) return;

  renderEngine(status);
  renderModels(status);
}

function renderEngine(status) {
  const engine = status.engine || {};
  const values = els.info.querySelectorAll("dd");
  if (!values.length) return;

  values[0].textContent = engine.rembg ? `installed${engine.version ? ` · ${engine.version}` : ""}` : "not installed";
  values[1].textContent = engine.python || "—";
  values[2].textContent = status.modelsDir || "—";
  values[3].textContent = status.server && status.server.version
    ? `v${status.server.version} · ${status.server.host || "127.0.0.1"}:${status.server.port || ""}`
    : "offline";

  els.badge.textContent = engine.rembg ? "ready" : "missing";
  els.badge.classList.toggle("is-ok", Boolean(engine.rembg));
  els.badge.classList.toggle("is-bad", !engine.rembg);

  els.hint.hidden = Boolean(engine.rembg);
  if (!engine.rembg) {
    els.hint.textContent =
      engine.error ||
      'Install the engine once: py -m pip install "rembg[cpu,cli]" — then restart the server. Everything else in the toolkit keeps working without it.';
  }

  els.copyPath.disabled = !status.modelsDir;
}

function renderModels(status) {
  const installed = new Map((status.models || []).map((model) => [model.id, model]));
  const readyCount = [...installed.values()].filter((model) => model.installed).length;

  els.count.textContent = `${readyCount} of ${MODELS.length} downloaded`;
  els.list.replaceChildren();

  const fragment = document.createDocumentFragment();

  for (const model of MODELS) {
    const entry = installed.get(model.id);
    const isInstalled = Boolean(entry && entry.installed);
    const isDownloading = downloading.has(model.id);

    const row = document.createElement("li");
    row.className = "model-row";
    row.dataset.id = model.id;

    const dot = document.createElement("span");
    dot.className = "model-dot";
    if (isInstalled) dot.classList.add("is-installed");

    const copy = document.createElement("span");
    copy.className = "model-copy";
    const name = document.createElement("span");
    name.className = "model-name";
    name.textContent = model.name;
    const desc = document.createElement("span");
    desc.className = "model-desc";
    desc.textContent = model.desc;
    copy.append(name, desc);

    const size = document.createElement("span");
    size.className = "model-size";
    size.textContent = isInstalled && entry.bytes ? formatBytes(entry.bytes) : model.size;

    const action = document.createElement("button");
    action.type = "button";
    action.className = "btn btn-sm";

    if (isDownloading) {
      action.textContent = "Downloading…";
      action.disabled = true;
      action.classList.add("btn-ghost");
    } else if (isInstalled) {
      action.textContent = "Use";
      action.classList.add("btn-ghost");
      action.addEventListener("click", () => {
        document.dispatchEvent(new CustomEvent("app:usemodel", { detail: model.id }));
        document.dispatchEvent(new CustomEvent("app:gototab", { detail: "bg" }));
        toast(`${modelInfo(model.id).name} selected`);
      });
    } else {
      action.textContent = "Download";
      action.classList.add("btn-secondary");
      action.addEventListener("click", () => download(model.id));
    }

    row.append(dot, copy, size, action);
    fragment.append(row);
  }

  els.list.replaceChildren(fragment);
}

async function download(id) {
  if (downloading.has(id)) return;

  downloading.add(id);
  refreshStatus();
  startPolling();
  toast(`Downloading ${modelInfo(id).name} — this can take a few minutes`);

  try {
    await warmupModel(id);
    toast(`${modelInfo(id).name} is ready`);
  } catch (error) {
    console.error(error);
    toast(error.message || "The download failed");
  } finally {
    downloading.delete(id);
    await refreshStatus();
    if (downloading.size === 0) stopPolling();
  }
}

function startPolling() {
  if (poller) return;
  poller = window.setInterval(() => refreshStatus(), 3000);
}

function stopPolling() {
  if (!poller) return;
  window.clearInterval(poller);
  poller = 0;
}

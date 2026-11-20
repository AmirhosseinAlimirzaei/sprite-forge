/* Checker — folder gallery, transparency breakdown and pixel picking.
   Adapted from the standalone ImageChecker app, extended to JPG/WebP. */

import { $, $$, toast, formatBytes, formatPercent, clamp } from "../lib/ui.js";
import { alphaStats } from "../lib/image.js";

const STORAGE = {
  thumb: "aat.checker.thumb",
  backdrop: "aat.checker.backdrop",
  sort: "aat.checker.sort",
};

const BACKDROPS = ["checker", "dark", "light"];
const SORTS = ["folder", "name-asc", "name-desc", "newest", "oldest"];
const COLOUR_LABELS = { 0: "Grayscale", 2: "RGB", 3: "Indexed", 4: "Grayscale + alpha", 6: "RGBA" };
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const EXT_LABEL = { png: "PNG", jpg: "JPEG", jpeg: "JPEG", webp: "WebP" };

const state = {
  items: [],
  visible: [],
  rootName: "",
  query: "",
  sort: SORTS.includes(read(STORAGE.sort)) ? read(STORAGE.sort) : "folder",
  thumb: read(STORAGE.thumb) === null ? 30 : clamp(Number(read(STORAGE.thumb)), 0, 100),
  backdrop: BACKDROPS.includes(read(STORAGE.backdrop)) ? read(STORAGE.backdrop) : "checker",

  viewerList: [],
  viewerItem: null,
  viewerIndex: -1,
  loadToken: 0,
  imageReady: false,
  inspector: false,
  zoom: 1,
  fitW: 0,
  fitH: 0,
  panX: 0,
  panY: 0,
  pan: null,
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const numberFormatter = new Intl.NumberFormat(undefined);
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const pixelCanvas = document.createElement("canvas");
pixelCanvas.width = 1;
pixelCanvas.height = 1;
const pixelContext = pixelCanvas.getContext("2d", { willReadFrequently: true });

let nextId = 0;
let searchTimer = 0;
let resizeObserver = null;

const els = {};

export function init() {
  els.panel = $("#panel-checker");
  els.empty = $("#chkEmpty");
  els.view = $("#chkView");
  els.browse = $("#chkBrowse");
  els.folderInput = $("#chkFolder");
  els.folderName = $("#chkFolderName");
  els.count = $("#chkAssetCount");
  els.search = $("#chkSearch");
  els.searchClear = $("#chkSearchClear");
  els.size = $("#chkSize");
  els.sort = $("#chkSort");
  els.gallery = $("#chkGallery");
  els.noResults = $("#chkNoResults");
  els.noResultsText = $("#chkNoResultsText");
  els.clearSearch = $("#chkClearSearch");
  els.changeFolder = $("#chkChangeFolder");

  els.dialog = $("#chkViewer");
  els.vName = $("#chkViewerName");
  els.vPath = $("#chkViewerPath");
  els.vCounter = $("#chkViewerCounter");
  els.vStage = $("#chkViewerStage");
  els.vImage = $("#chkViewerImage");
  els.vLoader = $("#chkViewerLoader");
  els.vError = $("#chkViewerError");
  els.vClose = $("#chkViewerClose");
  els.vNav = $("#chkStageNav");
  els.vPrev = $("#chkPrev");
  els.vNext = $("#chkNext");

  els.pixelTip = $("#chkPixelTip");
  els.pixelFill = $("#chkPixelFill");
  els.pixelHex = $("#chkPixelHex");
  els.pixelAlpha = $("#chkPixelAlpha");
  els.pixelCoord = $("#chkPixelCoord");

  els.metaDimensions = $("#chkMetaDimensions");
  els.metaSize = $("#chkMetaSize");
  els.metaFormat = $("#chkMetaFormat");
  els.metaInterlaced = $("#chkMetaInterlaced");
  els.metaModified = $("#chkMetaModified");
  els.metaFolder = $("#chkMetaFolder");

  els.alphaStatus = $("#chkAlphaStatus");
  els.alphaBar = $("#chkAlphaBar");
  els.alphaClearSeg = $("#chkAlphaClearSeg");
  els.alphaSemiSeg = $("#chkAlphaSemiSeg");
  els.alphaOpaqueSeg = $("#chkAlphaOpaqueSeg");
  els.alphaClear = $("#chkAlphaClear");
  els.alphaSemi = $("#chkAlphaSemi");
  els.alphaOpaque = $("#chkAlphaOpaque");
  els.alphaNote = $("#chkAlphaNote");

  els.inspectorBtn = $("#chkInspectorBtn");
  els.zoomIn = $("#chkZoomIn");
  els.zoomOut = $("#chkZoomOut");
  els.zoomReset = $("#chkZoomReset");

  if (!els.dialog || !els.folderInput) return;

  applyThumb(state.thumb, false);
  setBackdrop(state.backdrop, false);
  els.sort.value = state.sort;

  els.browse.addEventListener("click", chooseFolder);
  els.changeFolder.addEventListener("click", chooseFolder);
  els.folderInput.addEventListener("change", handleFolderInput);

  els.search.addEventListener("input", handleSearchInput);
  els.search.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (els.search.value) clearSearch();
    else els.search.blur();
  });
  els.searchClear.addEventListener("click", clearSearch);
  els.clearSearch.addEventListener("click", clearSearch);
  els.sort.addEventListener("change", () => setSort(els.sort.value, true));

  els.size.addEventListener("input", () => applyThumb(Number(els.size.value), false));
  els.size.addEventListener("change", () => applyThumb(Number(els.size.value), true));

  document.addEventListener("click", (event) => {
    const swatch = event.target.closest(".swatch[data-backdrop]");
    if (!swatch) return;
    setBackdrop(swatch.dataset.backdrop, true);
  });

  els.vClose.addEventListener("click", closeViewer);
  els.dialog.addEventListener("click", (event) => {
    if (event.target === els.dialog) closeViewer();
  });
  els.dialog.addEventListener("close", handleViewerClose);
  els.vPrev.addEventListener("click", () => navigateViewer(-1));
  els.vNext.addEventListener("click", () => navigateViewer(1));

  els.inspectorBtn.addEventListener("click", () => setInspector(!state.inspector));
  els.zoomOut.addEventListener("click", () => setZoom(state.zoom / 1.25));
  els.zoomIn.addEventListener("click", () => setZoom(state.zoom * 1.25));
  els.zoomReset.addEventListener("click", () => {
    setZoom(1);
    setSplitFit();
    hidePixelTip();
  });

  els.vStage.addEventListener("wheel", handleWheel, { passive: false });
  els.vStage.addEventListener("pointerdown", handlePointerDown);
  els.vStage.addEventListener("pointermove", handlePointerMove);
  els.vStage.addEventListener("pointerup", endPan);
  els.vStage.addEventListener("pointercancel", endPan);
  els.vStage.addEventListener("pointerleave", () => {
    if (!state.pan) hidePixelTip();
  });
  els.vStage.addEventListener("dblclick", (event) => {
    if (state.inspector || event.target.closest("button") || !state.imageReady) return;
    setZoom(state.zoom > 1.01 ? 1 : 2);
  });

  document.addEventListener("keydown", handleKeydown);

  if ("ResizeObserver" in window) {
    resizeObserver = new ResizeObserver(() => {
      if (els.dialog.open && state.viewerItem && state.imageReady) {
        fitViewerImage({ reset: false });
      }
    });
    resizeObserver.observe(els.vStage);
  }

  updateSearchClear();
}

/* -------------------------------------------------------------- folder load */

async function chooseFolder() {
  if (typeof window.showDirectoryPicker === "function") {
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: "read" });
    } catch (error) {
      if (error && error.name === "AbortError") return;
      console.warn(error);
      toast(error && error.name === "SecurityError" ? "Folder access is blocked here. Open the app through localhost." : "The folder picker could not be opened.");
      return;
    }
    await loadFromDirectory(handle);
    return;
  }

  els.folderInput.click();
}

async function loadFromDirectory(directoryHandle) {
  try {
    const found = [];
    await walkDirectory(directoryHandle, "", found);

    if (found.length === 0) {
      toast(`No supported images in “${directoryHandle.name}”.`);
      return;
    }

    await loadFolder(found, directoryHandle.name);
  } catch (error) {
    console.error(error);
    toast("That folder could not be read.");
  }
}

async function walkDirectory(directoryHandle, prefix, found) {
  let iterator;

  try {
    iterator = directoryHandle.values();
  } catch (error) {
    console.warn("Could not access folder", directoryHandle && directoryHandle.name, error);
    return;
  }

  try {
    for await (const entry of iterator) {
      if (entry.kind === "directory") {
        await walkDirectory(entry, `${prefix}${entry.name}/`, found);
        continue;
      }

      if (entry.kind !== "file" || !isImageName(entry.name)) continue;

      try {
        const file = await entry.getFile();
        found.push({ file, path: `${prefix}${entry.name}` });
      } catch (error) {
        console.warn("Could not read file", entry.name, error);
      }
    }
  } catch (error) {
    console.warn("Could not finish scanning", directoryHandle && directoryHandle.name, error);
  }
}

async function handleFolderInput() {
  const allFiles = Array.from(els.folderInput.files || []);
  els.folderInput.value = "";

  if (allFiles.length === 0) return;

  const images = allFiles.filter((file) => isImageName(file.name));

  if (images.length === 0) {
    toast("No PNG, JPG or WebP files in that selection.");
    return;
  }

  const firstRelative = images[0].webkitRelativePath || "";
  const rootName = firstRelative.includes("/") ? firstRelative.split("/")[0] : "Selected files";

  const found = images.map((file) => {
    const relative = file.webkitRelativePath || "";
    let path = file.name;

    if (relative) {
      const parts = relative.split("/");
      path = parts.slice(1).join("/") || file.name;
    }

    return { file, path };
  });

  await loadFolder(found, rootName);
}

async function loadFolder(entries, rootName) {
  window.clearTimeout(searchTimer);
  closeViewer();

  els.gallery.replaceChildren();
  for (const item of state.items) {
    if (item.url) URL.revokeObjectURL(item.url);
  }
  state.items = [];

  const seen = new Set();

  for (const entry of entries) {
    if (!entry || !entry.file) continue;

    const path = String(entry.path || entry.file.name)
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");

    if (seen.has(path)) continue;
    seen.add(path);

    const slash = path.lastIndexOf("/");

    nextId += 1;
    state.items.push({
      id: `img-${nextId}`,
      file: entry.file,
      url: URL.createObjectURL(entry.file),
      name: entry.file.name,
      path,
      folder: slash > -1 ? path.slice(0, slash) : "",
      width: 0,
      height: 0,
      bitDepth: null,
      colourLabel: "",
      interlace: null,
      lastModified: entry.file.lastModified || 0,
      alpha: null,
      alphaFailed: false,
    });
  }

  await mapWithConcurrency(state.items, 12, async (item) => {
    const info = await readPngHeader(item.file);
    if (!info) return;
    item.width = info.width;
    item.height = info.height;
    item.bitDepth = info.bitDepth;
    item.colourLabel = info.colourLabel;
    item.interlace = info.interlace;
  });

  state.rootName = rootName || "Selected folder";
  state.query = "";
  state.visible = [];
  els.search.value = "";
  updateSearchClear();

  els.folderName.textContent = state.rootName;
  els.folderName.title = state.rootName;
  els.empty.hidden = true;
  els.view.hidden = false;

  renderGallery();
  els.panel.scrollTop = 0;
}

async function readPngHeader(file) {
  if (!file || file.size < 29) return null;
  if (!/\.png$/i.test(file.name)) return null;

  try {
    const buffer = await file.slice(0, 29).arrayBuffer();
    const bytes = new Uint8Array(buffer);

    for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
      if (bytes[index] !== PNG_SIGNATURE[index]) return null;
    }

    const view = new DataView(buffer);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (!width || !height) return null;

    const bitDepth = bytes[24];
    const colourType = bytes[25];

    return {
      width,
      height,
      bitDepth,
      colourLabel: COLOUR_LABELS[colourType] || "PNG",
      interlace: bytes[28] === 1,
    };
  } catch (error) {
    console.warn("Could not parse PNG header", file && file.name, error);
    return null;
  }
}

async function mapWithConcurrency(items, limit, worker) {
  let index = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      try {
        await worker(items[current], current);
      } catch (error) {
        console.warn("Batch task failed", error);
      }
    }
  });

  await Promise.all(runners);
}

/* ------------------------------------------------------------------ gallery */

function applyThumb(value, persist) {
  state.thumb = clamp(Number.isFinite(value) ? value : 30, 0, 100);
  const pixels = Math.round(132 + state.thumb * 2.6);

  if (els.panel) els.panel.style.setProperty("--tile-size", `${pixels}px`);
  if (els.size) {
    els.size.value = String(state.thumb);
    els.size.setAttribute("aria-valuetext", `${pixels} pixels`);
  }

  if (persist) write(STORAGE.thumb, String(state.thumb));
}

function setBackdrop(value, persist) {
  if (!BACKDROPS.includes(value)) return;
  state.backdrop = value;

  if (els.panel) els.panel.dataset.backdrop = value;
  if (els.dialog) els.dialog.dataset.backdrop = value;

  $$("[data-backdrop]").forEach((button) => {
    if (!button.classList.contains("swatch")) return;
    const active = button.dataset.backdrop === value;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  if (persist) write(STORAGE.backdrop, value);
}

function setSort(value, persist) {
  if (!SORTS.includes(value)) return;
  state.sort = value;
  els.sort.value = value;
  if (persist) write(STORAGE.sort, value);
  if (state.items.length > 0) renderGallery();
}

function handleSearchInput() {
  state.query = els.search.value;
  updateSearchClear();
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(renderGallery, 80);
}

function clearSearch() {
  els.search.value = "";
  state.query = "";
  updateSearchClear();
  els.search.focus();
  renderGallery();
}

function updateSearchClear() {
  els.searchClear.hidden = els.search.value.length === 0;
}

function renderGallery() {
  const rawQuery = state.query.trim();
  const query = rawQuery.toLocaleLowerCase();

  const visible = state.items.filter((item) => !query || item.path.toLocaleLowerCase().includes(query));
  visible.sort(compareItems);
  state.visible = visible;

  const subfolders = new Set(state.items.filter((item) => item.folder).map((item) => item.folder)).size;
  const noun = state.items.length === 1 ? "image" : "images";

  if (query) {
    els.count.textContent = `${visible.length} of ${state.items.length} ${noun}`;
  } else {
    const suffix = subfolders > 0 ? ` · ${subfolders} subfolder${subfolders === 1 ? "" : "s"}` : "";
    els.count.textContent = `${state.items.length} ${noun}${suffix}`;
  }

  els.noResults.hidden = visible.length > 0;
  els.gallery.hidden = visible.length === 0;

  if (visible.length === 0) {
    els.noResultsText.textContent = query
      ? `Nothing inside “${rawQuery}” matches in ${state.rootName}.`
      : "No images to display.";
    els.clearSearch.hidden = !query;
  }

  const fragment = document.createDocumentFragment();
  for (const item of visible) fragment.append(createTile(item));
  els.gallery.replaceChildren(fragment);
}

function createTile(item) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "tile";
  tile.dataset.id = item.id;
  tile.setAttribute("aria-label", `Open ${item.name}`);
  tile.title = tileTitle(item);

  const media = document.createElement("span");
  media.className = "tile-media";

  const image = document.createElement("img");
  image.loading = "lazy";
  image.decoding = "async";
  image.alt = "";

  const error = document.createElement("span");
  error.className = "tile-error";
  error.hidden = true;
  error.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-image"/></svg><span>Preview unavailable</span>';

  media.append(image, error);

  const caption = document.createElement("span");
  caption.className = "tile-caption";

  const text = document.createElement("span");
  text.className = "tile-text";
  const name = document.createElement("span");
  name.className = "tile-name";
  name.textContent = item.name;
  const meta = document.createElement("span");
  meta.className = "tile-meta";
  meta.textContent = tileMeta(item);
  text.append(name, meta);

  const badge = document.createElement("span");
  badge.className = "tile-alpha";
  badge.hidden = true;
  badge.title = "Contains transparency";
  badge.textContent = "α";

  caption.append(text, badge);
  tile.append(media, caption);

  image.addEventListener(
    "load",
    () => {
      tile.classList.add("is-loaded");

      if (!item.width && image.naturalWidth) {
        item.width = image.naturalWidth;
        item.height = image.naturalHeight;
        meta.textContent = tileMeta(item);
        tile.title = tileTitle(item);
      }

      if (!item.alpha && !item.alphaFailed) ensureAlpha(item, image);
      else syncAlphaBadge(badge, item);
    },
    { once: true }
  );

  image.addEventListener(
    "error",
    () => {
      tile.classList.add("is-loaded", "is-error");
      error.hidden = false;
      image.remove();
    },
    { once: true }
  );

  image.src = item.url;
  tile.addEventListener("click", () => openViewer(item));

  return tile;
}

function compareItems(a, b) {
  const folderOrder = collator.compare(a.folder, b.folder);
  const nameOrder = collator.compare(a.name, b.name);
  const pathOrder = collator.compare(a.path, b.path);

  switch (state.sort) {
    case "name-asc":
      return nameOrder || folderOrder;
    case "name-desc":
      return collator.compare(b.name, a.name) || folderOrder;
    case "newest":
      return (b.lastModified || 0) - (a.lastModified || 0) || pathOrder;
    case "oldest":
      return (a.lastModified || 0) - (b.lastModified || 0) || pathOrder;
    case "folder":
    default:
      return folderOrder || nameOrder || pathOrder;
  }
}

function tileMeta(item) {
  const parts = [];
  if (item.folder) parts.push(item.folder);
  if (item.width && item.height) {
    parts.push(`${numberFormatter.format(item.width)} × ${numberFormatter.format(item.height)}`);
  }
  return parts.length ? parts.join(" · ") : "image";
}

function tileTitle(item) {
  const parts = [displayPath(item)];
  if (item.width && item.height) {
    parts.push(`${numberFormatter.format(item.width)} × ${numberFormatter.format(item.height)}`);
  }
  if (item.file) parts.push(formatBytes(item.file.size));
  return parts.join(" · ");
}

/* ------------------------------------------------------------------- alpha */

function ensureAlpha(item, sourceImage) {
  if (item.alpha) {
    handleAlphaUpdated(item);
    return Promise.resolve(item.alpha);
  }
  if (item.alphaFailed) return Promise.resolve(null);

  return new Promise((resolve) => {
    window.setTimeout(() => {
      try {
        const naturalWidth = sourceImage.naturalWidth || item.width;
        const naturalHeight = sourceImage.naturalHeight || item.height;
        if (!naturalWidth || !naturalHeight) throw new Error("no dimensions");

        const maxSide = 128;
        const scale = Math.min(1, maxSide / Math.max(naturalWidth, naturalHeight));
        const width = Math.max(1, Math.round(naturalWidth * scale));
        const height = Math.max(1, Math.round(naturalHeight * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("no canvas");

        context.clearRect(0, 0, width, height);
        context.drawImage(sourceImage, 0, 0, width, height);

        const stats = alphaStats(context.getImageData(0, 0, width, height).data);
        item.alpha = { ...stats, sampleWidth: width, sampleHeight: height };

        resolve(item.alpha);
        handleAlphaUpdated(item);
      } catch (error) {
        console.warn("Could not analyse transparency", item.name, error);
        item.alphaFailed = true;
        resolve(null);
        handleAlphaUpdated(item);
      }
    }, 0);
  });
}

function handleAlphaUpdated(item) {
  $$(".tile", els.gallery).forEach((tile) => {
    if (tile.dataset.id !== item.id) return;
    syncAlphaBadge($(".tile-alpha", tile), item);
    const meta = $(".tile-meta", tile);
    if (meta) meta.textContent = tileMeta(item);
  });

  if (els.dialog.open && state.viewerItem && state.viewerItem.id === item.id) {
    renderAlphaPanel(item);
  }
}

function syncAlphaBadge(badge, item) {
  if (!badge) return;
  const has = Boolean(item.alpha && item.alpha.hasTransparency);
  badge.hidden = !has;
  if (has) {
    const nonOpaque = item.alpha.clearPct + item.alpha.partialPct;
    badge.title = `${formatPercent(nonOpaque)} non-opaque pixels`;
  }
}

/* ------------------------------------------------------------------ viewer */

function openViewer(item) {
  if (!item) return;

  let list = state.visible.slice();
  let index = list.findIndex((candidate) => candidate.id === item.id);

  if (index === -1) {
    list = [item];
    index = 0;
  }

  closeViewer();
  state.viewerList = list;
  state.viewerIndex = index;
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  state.imageReady = false;

  if (!els.dialog.open) els.dialog.showModal();
  renderViewerItem(index, { focus: true });
}

function closeViewer() {
  if (els.dialog.open) els.dialog.close();
}

function navigateViewer(direction) {
  if (state.viewerList.length < 2) return;
  const length = state.viewerList.length;
  renderViewerItem((state.viewerIndex + direction + length) % length);
}

function renderViewerItem(index, options = {}) {
  const item = state.viewerList[index];
  if (!item) return;

  state.viewerIndex = index;
  state.viewerItem = item;
  state.imageReady = false;
  state.loadToken += 1;
  const token = state.loadToken;

  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  state.fitW = 0;
  state.fitH = 0;

  hidePixelTip();
  els.vName.textContent = item.name;
  els.vName.title = item.name;
  els.vPath.textContent = displayPath(item);
  els.vPath.title = displayPath(item);
  els.vCounter.textContent = `${index + 1} / ${state.viewerList.length}`;
  els.vNav.hidden = state.viewerList.length < 2;

  populateMetadata(item);
  renderAlphaPanel(item);

  els.vLoader.hidden = false;
  els.vError.hidden = true;
  els.vImage.classList.remove("is-ready");
  els.vImage.alt = item.name;
  els.vImage.onload = () => {
    if (token !== state.loadToken) return;
    handleImageLoad();
  };
  els.vImage.onerror = () => {
    if (token !== state.loadToken) return;
    handleImageError();
  };

  els.vImage.src = item.url;
  fitViewerImage({ reset: true });
  applyTransform();

  if (options.focus) {
    window.requestAnimationFrame(() => els.vClose.focus({ preventScroll: true }));
  }
}

function handleImageLoad() {
  if (!els.dialog.open || !state.viewerItem) return;

  const item = state.viewerItem;
  state.imageReady = true;

  if (!item.width && els.vImage.naturalWidth) {
    item.width = els.vImage.naturalWidth;
    item.height = els.vImage.naturalHeight;
    populateMetadata(item);
  }

  els.vLoader.hidden = true;
  els.vError.hidden = true;
  els.vImage.classList.add("is-ready");
  fitViewerImage({ reset: true });

  if (!item.alpha && !item.alphaFailed) ensureAlpha(item, els.vImage);
  else renderAlphaPanel(item);
}

function handleImageError() {
  if (!els.dialog.open || !state.viewerItem) return;
  state.imageReady = false;
  els.vLoader.hidden = true;
  els.vImage.classList.remove("is-ready");
  els.vError.hidden = false;
  if (!state.viewerItem.alpha) renderAlphaPanel({ ...state.viewerItem, alphaFailed: true });
}

function handleViewerClose() {
  // The close event is queued: ignore it if a new viewer session already started.
  if (els.dialog.open) return;

  state.loadToken += 1;
  state.imageReady = false;
  state.viewerItem = null;
  state.pan = null;

  els.vImage.onload = null;
  els.vImage.onerror = null;
  els.vImage.removeAttribute("src");
  els.vImage.classList.remove("is-ready");
  els.vLoader.hidden = true;
  els.vError.hidden = true;
  els.vStage.classList.remove("is-panning", "can-pan");
  hidePixelTip();
  setInspector(false);
}

function populateMetadata(item) {
  els.metaDimensions.textContent =
    item.width && item.height ? `${numberFormatter.format(item.width)} × ${numberFormatter.format(item.height)} px` : "—";

  els.metaSize.textContent = item.file ? formatBytes(item.file.size) : "—";

  const ext = String(item.name).split(".").pop().toLowerCase();
  const base = EXT_LABEL[ext] || "Image";
  els.metaFormat.textContent =
    item.bitDepth !== null && item.colourLabel ? `${base} · ${item.bitDepth}-bit ${item.colourLabel}` : base;

  els.metaInterlaced.textContent = item.interlace === null ? "—" : item.interlace ? "Yes" : "No";
  els.metaModified.textContent = item.lastModified ? dateFormatter.format(new Date(item.lastModified)) : "—";

  const folderPath = item.folder ? `${state.rootName} / ${item.folder}` : state.rootName;
  els.metaFolder.textContent = folderPath;
  els.metaFolder.title = folderPath;
}

function renderAlphaPanel(item) {
  const alpha = item.alpha;

  if (!alpha) {
    els.alphaBar.classList.add("is-loading");
    els.alphaStatus.textContent = item.alphaFailed ? "Unavailable" : "Checking";
    els.alphaStatus.classList.remove("is-transparent", "is-opaque");
    els.alphaClear.textContent = "—";
    els.alphaSemi.textContent = "—";
    els.alphaOpaque.textContent = "—";
    els.alphaNote.textContent = item.alphaFailed
      ? "Transparency could not be measured for this image."
      : "Sampling pixel transparency…";
    return;
  }

  els.alphaBar.classList.remove("is-loading");
  els.alphaClearSeg.style.width = `${alpha.clearPct}%`;
  els.alphaSemiSeg.style.width = `${alpha.partialPct}%`;
  els.alphaOpaqueSeg.style.width = `${alpha.opaquePct}%`;

  els.alphaStatus.textContent = alpha.hasTransparency ? "Transparent" : "Opaque";
  els.alphaStatus.classList.toggle("is-transparent", alpha.hasTransparency);
  els.alphaStatus.classList.toggle("is-opaque", !alpha.hasTransparency);

  els.alphaClear.textContent = formatPercent(alpha.clearPct);
  els.alphaSemi.textContent = formatPercent(alpha.partialPct);
  els.alphaOpaque.textContent = formatPercent(alpha.opaquePct);

  if (alpha.clearPct >= 99.95) {
    els.alphaNote.textContent = "Every sampled pixel is fully transparent.";
  } else if (!alpha.hasTransparency) {
    els.alphaNote.textContent = "Every sampled pixel is fully opaque.";
  } else {
    els.alphaNote.textContent = `Alpha sampled at ${alpha.sampleWidth} × ${alpha.sampleHeight} px.`;
  }
}

function displayPath(item) {
  return [state.rootName, ...item.path.split("/")].filter(Boolean).join(" / ");
}

/* ------------------------------------------------------------- zoom and pan */

function fitViewerImage({ reset }) {
  const item = state.viewerItem;
  if (!item) return;

  const naturalWidth = (state.imageReady ? els.vImage.naturalWidth : 0) || item.width || 0;
  const naturalHeight = (state.imageReady ? els.vImage.naturalHeight : 0) || item.height || 0;

  if (!naturalWidth || !naturalHeight || !els.vStage.clientWidth || !els.vStage.clientHeight) return;

  const gutter = Math.max(22, Math.min(60, els.vStage.clientWidth * 0.08));
  const availableWidth = Math.max(40, els.vStage.clientWidth - gutter * 2);
  const availableHeight = Math.max(40, els.vStage.clientHeight - gutter * 2);
  const scale = Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight);

  state.fitW = naturalWidth * scale;
  state.fitH = naturalHeight * scale;

  els.vImage.style.width = `${state.fitW}px`;
  els.vImage.style.height = `${state.fitH}px`;

  if (reset) {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
  } else {
    clampPan();
  }

  applyTransform();
}

function applyTransform() {
  const stage = els.vStage;
  if (!stage) return;

  const centerX = stage.clientWidth / 2 + state.panX;
  const centerY = stage.clientHeight / 2 + state.panY;

  els.vImage.style.left = `${centerX}px`;
  els.vImage.style.top = `${centerY}px`;
  els.vImage.style.transform = `translate(-50%, -50%) scale(${state.zoom})`;
  els.vImage.style.imageRendering = state.zoom > 1.5 ? "pixelated" : "auto";

  const isFit = state.zoom <= 1.001;
  els.zoomReset.textContent = isFit ? "Fit" : `${Math.round(state.zoom * 100)}%`;
  els.zoomReset.classList.toggle("is-fit", isFit);
  els.vStage.classList.toggle("can-pan", !isFit && !state.inspector);
}

function setSplitFit() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  applyTransform();
}

function clampPan() {
  const stage = els.vStage;
  const overflowX = Math.max(0, (state.fitW * state.zoom - stage.clientWidth) / 2);
  const overflowY = Math.max(0, (state.fitH * state.zoom - stage.clientHeight) / 2);
  state.panX = clamp(state.panX, -overflowX, overflowX);
  state.panY = clamp(state.panY, -overflowY, overflowY);
}

function setZoom(nextZoom) {
  if (!state.imageReady && !state.viewerItem) return;

  const next = clamp(nextZoom, 1, 8);
  if (Math.abs(next - state.zoom) < 0.001) return;

  state.zoom = next;

  if (next <= 1.001) {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
  } else {
    clampPan();
  }

  hidePixelTip();
  applyTransform();
}

function handleWheel(event) {
  if (!els.dialog.open) return;
  event.preventDefault();
  if (!state.imageReady) return;
  setZoom(state.zoom * (event.deltaY < 0 ? 1.18 : 1 / 1.18));
}

function handlePointerDown(event) {
  if (!els.dialog.open || state.inspector || !state.imageReady) return;
  if (event.button !== 0 || event.target.closest("button")) return;
  if (state.zoom <= 1.001) return;

  event.preventDefault();
  state.pan = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: state.panX, panY: state.panY };

  els.vStage.classList.add("is-panning");
  els.vStage.setPointerCapture?.(event.pointerId);
  hidePixelTip();
}

function handlePointerMove(event) {
  if (state.pan && event.pointerId === state.pan.pointerId) {
    state.panX = state.pan.panX + (event.clientX - state.pan.startX);
    state.panY = state.pan.panY + (event.clientY - state.pan.startY);
    clampPan();
    applyTransform();
    return;
  }

  if (state.inspector && state.imageReady) samplePixel(event);
}

function endPan(event) {
  if (!state.pan) return;
  if (event.pointerId !== state.pan.pointerId) return;
  if (els.vStage.hasPointerCapture?.(event.pointerId)) els.vStage.releasePointerCapture(event.pointerId);
  state.pan = null;
  els.vStage.classList.remove("is-panning");
}

/* ------------------------------------------------------------- pixel picker */

function setInspector(active) {
  state.inspector = active;
  els.inspectorBtn.classList.toggle("is-active", active);
  els.inspectorBtn.setAttribute("aria-pressed", String(active));
  els.vStage.classList.toggle("is-inspecting", active);
  els.vStage.classList.toggle("can-pan", state.zoom > 1.001 && !active);
  if (!active) hidePixelTip();
}

function samplePixel(event) {
  if (!pixelContext || !state.viewerItem) {
    hidePixelTip();
    return;
  }

  const rect = els.vImage.getBoundingClientRect();

  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  ) {
    hidePixelTip();
    return;
  }

  const naturalWidth = els.vImage.naturalWidth;
  const naturalHeight = els.vImage.naturalHeight;
  if (!naturalWidth || !naturalHeight) {
    hidePixelTip();
    return;
  }

  const relativeX = (event.clientX - rect.left) / rect.width;
  const relativeY = (event.clientY - rect.top) / rect.height;
  const pixelX = clamp(Math.floor(relativeX * naturalWidth), 0, naturalWidth - 1);
  const pixelY = clamp(Math.floor(relativeY * naturalHeight), 0, naturalHeight - 1);

  try {
    pixelContext.clearRect(0, 0, 1, 1);
    pixelContext.drawImage(els.vImage, pixelX, pixelY, 1, 1, 0, 0, 1, 1);

    const [red, green, blue, alpha] = pixelContext.getImageData(0, 0, 1, 1).data;

    els.pixelFill.style.backgroundColor = `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
    els.pixelHex.textContent = `#${hex(red)}${hex(green)}${hex(blue)}`;
    els.pixelAlpha.textContent = `α ${Math.round((alpha / 255) * 100)}%`;
    els.pixelCoord.textContent = `${pixelX}, ${pixelY}`;

    els.pixelTip.hidden = false;
    positionPixelTip(event);
  } catch (error) {
    console.warn("Could not sample pixel", error);
    hidePixelTip();
  }
}

function positionPixelTip(event) {
  const stageRect = els.vStage.getBoundingClientRect();
  const tipWidth = els.pixelTip.offsetWidth;
  const tipHeight = els.pixelTip.offsetHeight;

  let x = event.clientX - stageRect.left + 14;
  let y = event.clientY - stageRect.top + 14;

  if (x + tipWidth > stageRect.width - 8) x = event.clientX - stageRect.left - tipWidth - 14;
  if (y + tipHeight > stageRect.height - 8) y = event.clientY - stageRect.top - tipHeight - 14;

  x = clamp(x, 8, Math.max(8, stageRect.width - tipWidth - 8));
  y = clamp(y, 8, Math.max(8, stageRect.height - tipHeight - 8));

  els.pixelTip.style.transform = `translate(${x}px, ${y}px)`;
}

function hidePixelTip() {
  if (els.pixelTip) els.pixelTip.hidden = true;
}

/* ---------------------------------------------------------------- keyboard */

function handleKeydown(event) {
  const target = event.target;
  const typing =
    target instanceof HTMLElement &&
    (target.matches("input, textarea, select") || target.isContentEditable);

  if (els.dialog.open) {
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        navigateViewer(-1);
        return;
      case "ArrowRight":
        event.preventDefault();
        navigateViewer(1);
        return;
      case "i":
      case "I":
        if (event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        setInspector(!state.inspector);
        return;
      case "+":
      case "=":
        event.preventDefault();
        setZoom(state.zoom * 1.25);
        return;
      case "-":
      case "_":
        event.preventDefault();
        setZoom(state.zoom / 1.25);
        return;
      case "0":
        event.preventDefault();
        setZoom(1);
        hidePixelTip();
        return;
      default:
        break;
    }
  }

  if (event.key === "/" && !typing && !els.dialog.open && !els.view.hidden) {
    event.preventDefault();
    els.search.focus();
  }
}

/* ----------------------------------------------------------------- helpers */

function isImageName(name) {
  return /\.(png|jpe?g|webp)$/i.test(name);
}

function hex(value) {
  return value.toString(16).padStart(2, "0").toUpperCase();
}

function read(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage can be unavailable */
  }
}

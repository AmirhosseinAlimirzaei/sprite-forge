/* A small image queue: add files, select one, track per-file state. */

import { isImageFile, uid, formatDims } from "./ui.js";

export class ImageQueue {
  constructor({ list, count, template, onSelect, onChange }) {
    this.listEl = list;
    this.countEl = count;
    this.template = template;
    this.onSelect = onSelect || (() => {});
    this.onChange = onChange || (() => {});

    this.items = [];
    this.selectedId = null;
    this.nodes = new Map();
  }

  get selected() {
    return this.items.find((item) => item.id === this.selectedId) || null;
  }

  get size() {
    return this.items.length;
  }

  add(files) {
    const accepted = [];

    for (const file of files) {
      if (!isImageFile(file)) continue;

      const duplicate = this.items.some(
        (item) =>
          item.name === file.name &&
          item.size === file.size &&
          item.file.lastModified === file.lastModified
      );
      if (duplicate) continue;

      accepted.push(file);
    }

    for (const file of accepted) {
      this.items.push({
        id: uid(),
        file,
        name: file.name,
        size: file.size,
        url: URL.createObjectURL(file),
        width: 0,
        height: 0,
        state: "idle",
        note: "",
        result: null,
        ms: 0,
      });
    }

    if (accepted.length > 0) {
      if (!this.selectedId) this.select(this.items[0].id, false);
      this.render();
      this.onChange(this);
      this.onSelect(this.selected);
    }

    return accepted.length;
  }

  render() {
    const fragment = document.createDocumentFragment();
    this.nodes.clear();

    for (const item of this.items) {
      const node = this.template.content.firstElementChild.cloneNode(true);
      const image = node.querySelector("img");
      const nameEl = node.querySelector(".file-name");
      const subEl = node.querySelector(".file-sub");
      const stateEl = node.querySelector(".file-state");
      const removeBtn = node.querySelector(".file-remove");

      node.dataset.id = item.id;
      node.tabIndex = 0;
      node.setAttribute("role", "button");
      node.setAttribute("aria-label", item.name);

      nameEl.textContent = item.name;
      subEl.textContent = this.subtitle(item);

      image.addEventListener(
        "load",
        () => {
          if (!item.width && image.naturalWidth) {
            item.width = image.naturalWidth;
            item.height = image.naturalHeight;
            subEl.textContent = this.subtitle(item);
          }
        },
        { once: true }
      );
      image.addEventListener("error", () => {
        subEl.textContent = "unreadable";
        image.remove();
      });
      image.src = item.url;

      node.addEventListener("click", () => this.select(item.id));
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.select(item.id);
        }
      });

      removeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.remove(item.id);
      });

      this.nodes.set(item.id, { node, image, nameEl, subEl, stateEl });
      this.applyState(item);
      node.classList.toggle("is-selected", item.id === this.selectedId);
      fragment.append(node);
    }

    this.listEl.replaceChildren(fragment);
    if (this.countEl) {
      this.countEl.textContent =
        this.items.length === 1 ? "1 image" : `${this.items.length} images`;
    }
    this.onChange(this);
  }

  subtitle(item) {
    if (item.state === "error" && item.note) return item.note;
    if (item.width && item.height) return formatDims(item.width, item.height);
    return item.note || "—";
  }

  applyState(item) {
    const refs = this.nodes.get(item.id);
    if (!refs) return;

    const { stateEl, subEl } = refs;
    stateEl.className = "file-state";

    if (item.state === "working") {
      stateEl.classList.add("is-working");
      stateEl.textContent = "";
    } else if (item.state === "done") {
      stateEl.classList.add("is-done");
      stateEl.textContent = "✓";
    } else if (item.state === "error") {
      stateEl.classList.add("is-error");
      stateEl.textContent = "!";
    } else {
      stateEl.textContent = "";
    }

    if (subEl) subEl.textContent = this.subtitle(item);
  }

  setState(id, state, note = "") {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return;
    item.state = state;
    item.note = note;
    this.applyState(item);
  }

  setResult(id, result, ms = 0) {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return;

    if (item.result) releaseResult(item.result);

    item.result = result
      ? {
          ...result,
          url: URL.createObjectURL(result.blob),
          previewUrl: result.previewBlob ? URL.createObjectURL(result.previewBlob) : null,
        }
      : null;
    item.ms = ms;

    this.applyState(item);
  }

  select(id, notify = true) {
    if (this.selectedId === id && notify) {
      this.onSelect(this.selected);
      return;
    }

    this.selectedId = id;

    for (const [itemId, refs] of this.nodes) {
      refs.node.classList.toggle("is-selected", itemId === id);
    }

    if (notify) this.onSelect(this.selected);
  }

  remove(id) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return;

    const [item] = this.items.splice(index, 1);
    URL.revokeObjectURL(item.url);
    if (item.result) releaseResult(item.result);

    if (this.selectedId === id) {
      const next = this.items[index] || this.items[index - 1] || null;
      this.selectedId = next ? next.id : null;
    }

    this.render();
    this.onSelect(this.selected);
  }

  clear() {
    for (const item of this.items) {
      URL.revokeObjectURL(item.url);
      if (item.result) releaseResult(item.result);
    }

    this.items = [];
    this.selectedId = null;
    this.render();
    this.onSelect(null);
  }
}

function releaseResult(result) {
  if (result.url) URL.revokeObjectURL(result.url);
  if (result.previewUrl) URL.revokeObjectURL(result.previewUrl);
}

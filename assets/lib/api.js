/* Thin client for the local server. No network beyond 127.0.0.1. */

let cachedStatus = null;
const listeners = new Set();

export function getStatus() {
  return cachedStatus;
}

export function onStatus(callback) {
  listeners.add(callback);
  if (cachedStatus) callback(cachedStatus);
  return () => listeners.delete(callback);
}

function emit() {
  for (const callback of listeners) {
    try {
      callback(cachedStatus);
    } catch (error) {
      console.error("status listener failed", error);
    }
  }
}

export async function refreshStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    cachedStatus = await response.json();
    cachedStatus.online = true;
  } catch (error) {
    cachedStatus = {
      ok: false,
      online: false,
      engine: { rembg: false, version: null, python: null, error: "The local server is not responding." },
      models: [],
      modelsDir: "",
      server: {},
    };
    console.warn("status unavailable", error);
  }

  emit();
  return cachedStatus;
}

export async function removeBackground(file, { model, matting = false, erode = 10, signal } = {}) {
  const url = new URL("/api/remove", window.location.origin);
  url.searchParams.set("model", model);
  url.searchParams.set("matting", matting ? "1" : "0");
  url.searchParams.set("erode", String(erode));

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
    signal,
  });

  if (!response.ok) {
    let message = `Background removal failed (HTTP ${response.status})`;
    try {
      const payload = await response.json();
      if (payload && payload.error) message = payload.error;
    } catch {
      /* the body was not JSON */
    }
    throw new Error(message);
  }

  const blob = await response.blob();
  const ms = Number(response.headers.get("X-Asset-Ms") || 0);
  return { blob, ms };
}

export async function warmupModel(model) {
  const url = new URL("/api/warmup", window.location.origin);
  url.searchParams.set("model", model);

  const response = await fetch(url, { method: "POST" });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.error) {
    throw new Error(payload.error || `Could not prepare “${model}”.`);
  }
  return payload;
}

export async function revealModelFolder() {
  const response = await fetch("/api/reveal", { method: "POST" });
  if (!response.ok) throw new Error("Could not open the folder.");
  return true;
}

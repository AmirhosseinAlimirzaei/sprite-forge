/* Image pipeline: decode, inspect, trim, resize, encode — all in the browser. */

const MAX_SIDE = 12000;
const MAX_AREA = 40_000_000;

export function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/**
 * Decodes a File/Blob. Prefers createImageBitmap (off the main thread),
 * falls back to an <img> for older browsers.
 */
export async function loadImage(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        dispose() {
          if (typeof bitmap.close === "function") bitmap.close();
        },
      };
    } catch (error) {
      console.warn("createImageBitmap failed, falling back", error);
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("This image could not be decoded."));
      img.src = url;
    });

    if (!image.naturalWidth || !image.naturalHeight) {
      throw new Error("This image has no pixels.");
    }

    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      dispose() {
        URL.revokeObjectURL(url);
      },
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export function assertReasonableSize(width, height) {
  if (width > MAX_SIDE || height > MAX_SIDE) {
    throw new Error(`Image is too large (${width} × ${height}). The limit is ${MAX_SIDE}px per side.`);
  }
  if (width * height > MAX_AREA) {
    throw new Error(`Image has too many pixels (${width} × ${height}).`);
  }
}

export function drawToCanvas(source) {
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;

  assertReasonableSize(width, height);

  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) throw new Error("Canvas is unavailable in this browser.");

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0);
  return canvas;
}

export function readPixels(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Finds the bounding box of "solid" pixels.
 * Matches the desktop app: alpha >= threshold counts, and colour-matched
 * pixels are excluded from the box.
 */
export function trimBounds(data, width, height, { threshold = 10, color = null, fuzz = 30 } = {}) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  const hasColour = color && Number.isFinite(color.r);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width * 4;

    for (let x = 0; x < width; x += 1) {
      const index = rowStart + x * 4;
      if (data[index + 3] < threshold) continue;

      if (hasColour) {
        if (
          Math.abs(data[index] - color.r) <= fuzz &&
          Math.abs(data[index + 1] - color.g) <= fuzz &&
          Math.abs(data[index + 2] - color.b) <= fuzz
        ) {
          continue;
        }
      }

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Crops to the bounds and adds transparent padding on every side. */
export function cropWithPadding(source, bounds, padding = 0) {
  const pad = Math.max(0, Math.round(padding));
  const canvas = createCanvas(bounds.width + pad * 2, bounds.height + pad * 2);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(
    source,
    bounds.left,
    bounds.top,
    bounds.width,
    bounds.height,
    pad,
    pad,
    bounds.width,
    bounds.height
  );
  return canvas;
}

/**
 * Trims a canvas. Returns the original canvas when everything is empty.
 */
export function trimCanvas(source, options = {}) {
  const { data } = readPixels(source);
  const bounds = trimBounds(data, source.width, source.height, options);

  if (!bounds) {
    return {
      canvas: source,
      bounds: null,
      applied: false,
      reason: "empty",
    };
  }

  const padding = Math.max(0, options.padding || 0);
  const canvas = cropWithPadding(source, bounds, padding);

  return {
    canvas,
    bounds,
    applied: canvas.width !== source.width || canvas.height !== source.height,
    reason: canvas.width !== source.width || canvas.height !== source.height ? "trimmed" : "unchanged",
  };
}

export function alphaStats(data) {
  const total = Math.max(1, data.length / 4);
  let clear = 0;
  let partial = 0;

  for (let index = 3; index < data.length; index += 4) {
    const alpha = data[index];
    if (alpha === 0) clear += 1;
    else if (alpha < 255) partial += 1;
  }

  const clearPct = (clear / total) * 100;
  const partialPct = (partial / total) * 100;

  return {
    clearPct,
    partialPct,
    opaquePct: Math.max(0, 100 - clearPct - partialPct),
    hasTransparency: clear + partial > 0,
  };
}

export function computeContentSize(width, height, targetWidth, targetHeight, mode) {
  let scale = 1;

  switch (mode) {
    case "fit":
      scale = Math.min(targetWidth / width, targetHeight / height, 1);
      break;
    case "fit-up":
      scale = Math.min(targetWidth / width, targetHeight / height);
      break;
    case "canvas":
      scale = Math.min(targetWidth / width, targetHeight / height, 1);
      break;
    case "long":
      scale = targetWidth / Math.max(width, height);
      break;
    case "short":
      scale = targetWidth / Math.min(width, height);
      break;
    case "width":
      scale = targetWidth / width;
      break;
    case "height":
      scale = targetHeight / height;
      break;
    default:
      scale = 1;
  }

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

/** High quality resize. Halves repeatedly before the final step when shrinking a lot. */
export function resizeCanvas(source, targetWidth, targetHeight, smooth = true) {
  const width = Math.max(1, Math.round(targetWidth));
  const height = Math.max(1, Math.round(targetHeight));

  if (source.width === width && source.height === height) return source;

  let current = source;

  if (smooth) {
    let currentWidth = source.width;
    let currentHeight = source.height;

    while (
      currentWidth >= width * 2 &&
      currentHeight >= height * 2 &&
      currentWidth > 2 &&
      currentHeight > 2
    ) {
      currentWidth = Math.max(1, Math.round(currentWidth / 2));
      currentHeight = Math.max(1, Math.round(currentHeight / 2));

      const step = createCanvas(currentWidth, currentHeight);
      const context = step.getContext("2d");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(current, 0, 0, currentWidth, currentHeight);
      current = step;
    }
  }

  const output = createCanvas(width, height);
  const context = output.getContext("2d");
  context.imageSmoothingEnabled = Boolean(smooth);
  context.imageSmoothingQuality = "high";
  context.drawImage(current, 0, 0, width, height);
  return output;
}

/** Applies one of the seven resize modes and returns a new canvas. */
export function resizeToTarget(source, targetWidth, targetHeight, mode, smooth = true) {
  if (mode === "canvas") {
    const size = computeContentSize(source.width, source.height, targetWidth, targetHeight, mode);
    const fitted = resizeCanvas(source, size.width, size.height, smooth);
    const output = createCanvas(targetWidth, targetHeight);
    const context = output.getContext("2d");
    context.clearRect(0, 0, output.width, output.height);
    context.drawImage(fitted, Math.round((targetWidth - size.width) / 2), Math.round((targetHeight - size.height) / 2));
    return output;
  }

  const size = computeContentSize(source.width, source.height, targetWidth, targetHeight, mode);
  return resizeCanvas(source, size.width, size.height, smooth);
}

function flattenOnColour(source, colour) {
  const output = createCanvas(source.width, source.height);
  const context = output.getContext("2d");
  context.fillStyle = colour;
  context.fillRect(0, 0, output.width, output.height);
  context.drawImage(source, 0, 0);
  return output;
}

const MIME = { png: "image/png", webp: "image/webp", jpeg: "image/jpeg" };

/**
 * Encodes a canvas. Returns the format the browser actually produced, which
 * can differ from the request when WebP is unsupported.
 */
export async function encodeCanvas(canvas, format = "png", quality = 0.92) {
  const target = format === "jpeg" ? flattenOnColour(canvas, "#ffffff") : canvas;
  const mime = MIME[format] || MIME.png;

  const blob = await new Promise((resolve, reject) => {
    target.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("This image could not be encoded."))),
      mime,
      format === "png" ? undefined : quality
    );
  });

  const actual = blob.type === "image/webp" ? "webp" : blob.type === "image/jpeg" ? "jpeg" : "png";
  return { blob, format: actual };
}

/** Decode → canvas in one step. */
export async function blobToCanvas(blob) {
  const image = await loadImage(blob);
  try {
    const canvas = drawToCanvas(image.source);
    return { canvas, width: canvas.width, height: canvas.height };
  } finally {
    image.dispose();
  }
}

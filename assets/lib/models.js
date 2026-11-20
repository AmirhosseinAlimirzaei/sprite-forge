/* Model catalogue shared by the BG Remover and Models tabs. */

export const MODELS = [
  {
    id: "birefnet-general",
    name: "BiRefNet General",
    desc: "Best quality, slowest",
    size: "≈ 170 MB",
    quality: 5,
  },
  {
    id: "birefnet-general-lite",
    name: "BiRefNet General Lite",
    desc: "Near-SOTA quality, faster",
    size: "≈ 100 MB",
    quality: 4,
  },
  {
    id: "birefnet-portrait",
    name: "BiRefNet Portrait",
    desc: "People and characters",
    size: "≈ 170 MB",
    quality: 4,
  },
  {
    id: "isnet-general-use",
    name: "ISNet General",
    desc: "High precision, general purpose",
    size: "≈ 170 MB",
    quality: 4,
  },
  {
    id: "u2net",
    name: "U2Net",
    desc: "Classic all-rounder",
    size: "≈ 170 MB",
    quality: 3,
  },
  {
    id: "u2netp",
    name: "U2Net Lite",
    desc: "Fast and small",
    size: "≈ 4.7 MB",
    quality: 2,
  },
  {
    id: "u2net_human_seg",
    name: "U2Net Human Seg",
    desc: "Human figures",
    size: "≈ 170 MB",
    quality: 3,
  },
  {
    id: "isnet-anime",
    name: "ISNet Anime",
    desc: "Anime and cartoon art",
    size: "≈ 170 MB",
    quality: 4,
  },
  {
    id: "silueta",
    name: "Silueta",
    desc: "Small, silhouette focused",
    size: "≈ 44 MB",
    quality: 2,
  },
  {
    id: "u2net_cloth_seg",
    name: "U2Net Cloth Seg",
    desc: "Clothing only",
    size: "≈ 170 MB",
    quality: 2,
  },
];

const BY_ID = new Map(MODELS.map((model) => [model.id, model]));

export function modelInfo(id) {
  return BY_ID.get(id) || { id, name: id, desc: "", size: "—", quality: 0 };
}

/** Best default: highest quality model that is already downloaded. */
export function pickDefaultModel(status) {
  const installed = new Map((status?.models || []).map((m) => [m.id, m.installed]));

  const preferred = [
    "birefnet-general",
    "birefnet-general-lite",
    "isnet-general-use",
    "u2net",
    "silueta",
  ];

  for (const id of preferred) {
    if (installed.get(id)) return id;
  }

  const anyInstalled = MODELS.find((model) => installed.get(model.id));
  return anyInstalled ? anyInstalled.id : "birefnet-general";
}

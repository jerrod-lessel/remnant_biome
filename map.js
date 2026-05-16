/* ============================================================
   Remnant Biome - map.js
============================================================ */

const PNG_BASE = "";

const CA_BOUNDS = {
  minLat: 32.5, maxLat: 42.1,
  minLng: -124.5, maxLng: -114.1,
};

const PLAY_INTERVAL_MS = 325;

// Tuned bounds, shifted south to correct display offset
const IMG_BOUNDS = [-128.4375, 29.18, -110.9688, 44.68];

// Reveal circle settings
const REVEAL_RADIUS_MILES = 25;
const REVEAL_ZOOM         = 8;

// Outer bbox for the donut dark fill, well beyond CA + PNG spillover
const DONUT_BBOX = [-140, 22, -100, 52];

// Fringe rings, annuli just outside the hole, getting darker outward
const FRINGE_INNER_MULT = 0.80;
const FRINGE_STEPS = [
  { outerMult: 0.85, opacity: 0.20 },
  { outerMult: 0.90, opacity: 0.40 },
  { outerMult: 0.95, opacity: 0.65 },
  { outerMult: 1.00, opacity: 0.85 },
];

const BASEMAP_TILES = {
  "carto-light":    "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  "carto-dark":     "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  "esri-satellite": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  "osm":            "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
};

const CA_BOUNDARY_URL =
  "https://services.arcgis.com/ue9rwulIoeLEI9bj/arcgis/rest/services/US_StateBoundaries/FeatureServer/0";

// ── AGRONOMIC CONTEXT ─────────────────────────────────────────
// Plain-English "what does this mean?" copy for each metric.
// Shown in the interpretation sidebar regardless of location/year.

const METRIC_CONTEXT = {
  almonds_chill_hours: {
    what: "Almonds need a period of cold dormancy each winter (called chill hours) to set buds and bloom reliably in spring. Without enough cold, trees bloom unevenly or not at all, which hammers yields.",
    trend_direction: "declining",
    viable_note: "California's Central Valley historically had more than enough chill hours. That buffer is shrinking, and some lower-elevation orchards are already hitting the edge.",
    risk_note: "Almonds are California's #1 agricultural export. Growers are already trialing low-chill varieties, but there's a hard floor. Some cold is non-negotiable.",
  },
  wine_grapes_chill_hours: {
    what: "Wine grape vines also need winter chill to break dormancy cleanly. Without it, budburst is delayed and uneven, leading to poor fruit set and lower quality harvests.",
    trend_direction: "declining",
    viable_note: "Many premium wine regions (Napa, Sonoma, Paso Robles) still get adequate chill, but the margins are tightening, especially at lower elevations.",
    risk_note: "Variety selection matters enormously here. High-chill varieties like Cabernet Sauvignon are more exposed than lower-chill varieties like Grenache or Zinfandel.",
  },
  wine_grapes_gdd: {
    what: "Growing degree days (GDD) measure accumulated heat over the growing season, the thermal energy that drives fruit ripening. Too little and grapes don't ripen fully. Too much and they ripen too fast, losing complexity and driving up sugar without developing flavor.",
    trend_direction: "increasing",
    viable_note: "The ideal GDD window for premium wine grapes is roughly 2,500 to 3,500 degree days. Cooler coastal regions are warming into viability; hotter inland regions are warming past it.",
    risk_note: "This metric captures both edges of the wine climate envelope. Coastal fog zones are seeing opportunity; the Central Valley floor is seeing degradation.",
  },
  navel_orange_frost_days: {
    what: "Navel oranges are frost-sensitive. A single hard freeze can destroy a season's crop. This metric counts annual days below the critical freeze threshold, where fruit and tree tissue are at risk.",
    trend_direction: "declining",
    viable_note: "Warmer winters are actually reducing frost risk for oranges in most of California. This is one metric where climate change is moving in growers' favor, at least for now.",
    risk_note: "The caveat is weather volatility. Even if average frost days decline, rare but severe cold snaps (like those seen in Texas in 2021) can cause catastrophic one-season losses.",
  },
  avocado_hard_freeze_days: {
    what: "Avocados are among the most cold-sensitive tree crops grown in California. Even a brief hard freeze (temperatures below 30 degrees F) can kill fruit, damage wood, and in severe cases kill entire trees.",
    trend_direction: "declining",
    viable_note: "Southern California's coastal avocado belt has always had marginal frost exposure. Warming winters are reducing that risk, which could expand viable growing areas northward.",
    risk_note: "Like oranges, the bigger concern is extreme event risk rather than average conditions. Avocado trees take years to mature, and a single bad freeze can wipe out an entire orchard investment.",
  },
  navel_orangeworm_dd: {
    what: "Navel orangeworm (NOW) is the most damaging insect pest of California's nut crops, including almonds, pistachios, and walnuts. Warmer winters accelerate its development cycle, allowing more generations per year and higher populations at harvest.",
    trend_direction: "increasing",
    viable_note: "Degree day accumulation drives how many NOW generations complete before almond harvest. More heat means more generations, which means more damage. Current thresholds are calibrated to current climates.",
    risk_note: "This is one of the clearest win-for-pests scenarios in California agriculture. Warmer conditions extend the season and reduce winter die-off, compounding pressure on growers year after year.",
  },
  vine_mealybug_development_days: {
    what: "Vine mealybug is a serious vineyard pest that spreads grapevine leafroll virus, one of the most economically damaging vine diseases in California. Warmer winters mean more mealybug generations survive and develop, increasing vineyard pressure.",
    trend_direction: "increasing",
    viable_note: "Mealybug development stalls in cold weather. As winters warm, the pest is able to complete more of its life cycle through the cold months, leading to higher populations come spring.",
    risk_note: "The economic damage from leafroll virus can take years to show and is essentially irreversible once established in a vineyard block. Earlier and heavier pressure from mealybug accelerates that timeline.",
  },
  spotted_wing_drosophila_mortality: {
    what: "Spotted wing drosophila (SWD) is an invasive fruit fly that attacks soft-skinned fruits including berries, cherries, and stone fruits before harvest. Unlike most fruit flies, it targets healthy ripening fruit. Cold winter temperatures kill overwintering adults, providing natural population control.",
    trend_direction: "declining",
    viable_note: "This metric tracks winter cold mortality. More cold means more SWD die-off, which is good for growers. Warming winters mean fewer SWD die, which means heavier pressure the following season.",
    risk_note: "SWD has already caused significant economic damage to California berry and cherry growers since its arrival in 2008. Reduced winter mortality from warming is expected to worsen pressure in most regions.",
  },
};

let metadata       = null;
let activeMetric   = "almonds_chill_hours";
let activeScenario = "ssp245";
let activeYear     = 2045;
let isPlaying      = false;
let playTimer      = null;
let activeMarker   = null;
let timelineChart  = null;
let clickedPoint   = null;
let activeBasemap  = "carto-light";
let revealActive   = false;
let sidebarOpen    = false;

// ── CHART DATA CACHE ──────────────────────────────────────────
const chartDataCache = {};

// ── IMAGE PRELOAD CACHE ───────────────────────────────────────
const preloadedImages = {};

// ── MAP INIT ──────────────────────────────────────────────────

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      basemap: {
        type: "raster",
        tiles: [BASEMAP_TILES["carto-light"]],
        tileSize: 256,
        attribution: "© Carto © OpenStreetMap contributors",
        maxzoom: 19,
      },
    },
    layers: [{
      id: "basemap-layer",
      type: "raster",
      source: "basemap",
    }],
  },
  center: [-119.5, 37.5],
  zoom: 5.0,
  minZoom: 4,
  maxZoom: 12,
  attributionControl: true,
});

// ── LOAD METADATA ─────────────────────────────────────────────

async function loadMetadata() {
  try {
    const resp = await fetch(`${PNG_BASE}/pngs/metadata.json`);
    metadata = await resp.json();
    return true;
  } catch (err) {
    console.error("Failed to load metadata.json:", err);
    return false;
  }
}

// ── CALIFORNIA MASK ───────────────────────────────────────────

async function addCaliforniaMask() {
  try {
    const query = `${CA_BOUNDARY_URL}/query?where=NAME='California'&outFields=NAME&returnGeometry=true&f=geojson`;
    const resp  = await fetch(query);
    const fc    = await resp.json();

    if (!fc.features || !fc.features.length) {
      console.warn("CA boundary: no features returned");
      return;
    }

    const caGeom = fc.features[0].geometry;
    const worldRing = [
      [-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]
    ];

    let caRings = [];
    if (caGeom.type === "Polygon") {
      caRings = caGeom.coordinates;
    } else if (caGeom.type === "MultiPolygon") {
      caGeom.coordinates.forEach(poly =>
        poly.forEach(ring => caRings.push(ring))
      );
    }

    map.addSource("ca-mask", {
      type: "geojson",
      data: {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [worldRing, ...caRings],
        },
      },
      tolerance: 0,
      buffer: 0,
    });

    map.addLayer({
      id: "ca-mask-layer",
      type: "fill",
      source: "ca-mask",
      minzoom: 0,
      maxzoom: 24,
      paint: {
        "fill-color": "#000000",
        "fill-opacity": 0.45,
        "fill-outline-color": "rgba(0,0,0,0)",
      },
    });

    console.log("CA mask added");
  } catch (e) {
    console.warn("CA mask failed:", e);
  }
}

// ── DONUT REVEAL SETUP ────────────────────────────────────────

function setupRevealLayers() {
  const empty = { type: "FeatureCollection", features: [] };

  map.addSource("reveal-donut", { type: "geojson", data: empty });
  map.addLayer({
    id: "reveal-donut-layer",
    type: "fill",
    source: "reveal-donut",
    paint: {
      "fill-color": "#0c1f2c",
      "fill-opacity": 1.0,
      "fill-outline-color": "rgba(0,0,0,0)",
    },
  });

  FRINGE_STEPS.forEach((step, i) => {
    map.addSource(`reveal-fringe-${i}`, { type: "geojson", data: empty });
    map.addLayer({
      id: `reveal-fringe-${i}-layer`,
      type: "fill",
      source: `reveal-fringe-${i}`,
      paint: {
        "fill-color": "#0c1f2c",
        "fill-opacity": step.opacity,
        "fill-outline-color": "rgba(0,0,0,0)",
      },
    });
  });
}

// ── DONUT REVEAL UPDATE ───────────────────────────────────────

function updateRevealMask(lng, lat) {
  const radiusKm = REVEAL_RADIUS_MILES * 1.60934;
  const fullCircle = turf.circle([lng, lat], radiusKm, { steps: 64, units: "kilometers" });

  const [west, south, east, north] = DONUT_BBOX;
  const bboxRing = [
    [west, south], [east, south], [east, north], [west, north], [west, south]
  ];
  map.getSource("reveal-donut").setData({
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [bboxRing, fullCircle.geometry.coordinates[0]],
    },
  });

  FRINGE_STEPS.forEach((step, i) => {
    const outerKm = radiusKm * step.outerMult;
    const innerKm = i === 0
      ? radiusKm * FRINGE_INNER_MULT
      : radiusKm * FRINGE_STEPS[i - 1].outerMult;

    const outerCircle = turf.circle([lng, lat], outerKm, { steps: 64, units: "kilometers" });
    const innerCircle = turf.circle([lng, lat], innerKm, { steps: 64, units: "kilometers" });

    map.getSource(`reveal-fringe-${i}`).setData({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          outerCircle.geometry.coordinates[0],
          innerCircle.geometry.coordinates[0],
        ],
      },
    });
  });
}

function clearRevealMask() {
  const empty = { type: "FeatureCollection", features: [] };
  map.getSource("reveal-donut").setData(empty);
  FRINGE_STEPS.forEach((_, i) => {
    map.getSource(`reveal-fringe-${i}`).setData(empty);
  });
}

// ── PNG LAYER ─────────────────────────────────────────────────

function getPngUrl(metric, scenario, year) {
  return `${PNG_BASE}/pngs/${metric}/${scenario}_${year}.png`;
}

function getScenarioForYear(year, selectedScenario) {
  if (selectedScenario === "historical") return year <= 2014 ? "historical" : null;
  if (year <= 2014) return "historical";
  return selectedScenario;
}

function boundsToCoords(bounds) {
  const [west, south, east, north] = bounds;
  return [[west, south], [east, south], [east, north], [west, north]];
}

function updateMapLayer() {
  const scenario = getScenarioForYear(activeYear, activeScenario);
  if (!scenario) return;

  const url      = getPngUrl(activeMetric, scenario, activeYear);
  const sourceId = "climate-raster";
  const layerId  = "climate-raster-layer";

  if (map.getLayer(layerId)) {
    map.getSource(sourceId).updateImage({ url, coordinates: boundsToCoords(IMG_BOUNDS) });
  } else {
    map.addSource(sourceId, {
      type: "image",
      url,
      coordinates: boundsToCoords(IMG_BOUNDS),
    });
    map.addLayer(
      {
        id: layerId,
        type: "raster",
        source: sourceId,
        layout: { visibility: "none" },
        paint: {
          "raster-opacity": 0.85,
          "raster-resampling": "nearest",
        },
      },
      "ca-mask-layer"
    );
  }

  // Update sidebar if open
  if (sidebarOpen && clickedPoint) {
    updateSidebarContent();
  }
}

function showRasterLayer() {
  if (map.getLayer("climate-raster-layer")) {
    map.setLayoutProperty("climate-raster-layer", "visibility", "visible");
  }
}

function hideRasterLayer() {
  if (map.getLayer("climate-raster-layer")) {
    map.setLayoutProperty("climate-raster-layer", "visibility", "none");
  }
}

// ── IMAGE PRELOADING ──────────────────────────────────────────

function preloadFrames(fromYear, count = 6) {
  const maxYear = activeScenario === "historical" ? 2014 : 2100;
  for (let i = 1; i <= count; i++) {
    const yr = fromYear + i;
    if (yr > maxYear) break;
    const scenario = getScenarioForYear(yr, activeScenario);
    if (!scenario) continue;
    const url = getPngUrl(activeMetric, scenario, yr);
    if (!preloadedImages[url]) {
      const img = new Image();
      img.src = url;
      preloadedImages[url] = img;
    }
  }
}

// ── MAP READY ─────────────────────────────────────────────────

map.on("load", async () => {
  const ok = await loadMetadata();
  if (!ok) return;
  await addCaliforniaMask();
  updateMapLayer();
  setupRevealLayers();
  updateYearDisplay();
  checkDeficitBadge();
});

// ── CONTROLS ──────────────────────────────────────────────────

document.getElementById("zoom-in").addEventListener("click",  () => map.zoomIn());
document.getElementById("zoom-out").addEventListener("click", () => map.zoomOut());
document.getElementById("home-btn").addEventListener("click", () =>
  map.flyTo({ center: [-119.5, 37.5], zoom: 5.0, duration: 800 })
);

// ── PILLS ─────────────────────────────────────────────────────

document.querySelectorAll(".pill").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".pill").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    activeMetric = btn.dataset.metric;
    updateMapLayer();
    checkDeficitBadge();
    if (clickedPoint) updateTimeline(clickedPoint.lat, clickedPoint.lng);
  });
});

// ── SCENARIOS ─────────────────────────────────────────────────

document.querySelectorAll(".scenario-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".scenario-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeScenario = btn.dataset.scenario;

    if (activeScenario === "historical" && activeYear > 2014) {
      activeYear = 2014;
      document.getElementById("year-slider").value = 2014;
    } else if (activeScenario !== "historical" && activeYear < 2015) {
      activeYear = 2015;
      document.getElementById("year-slider").value = 2015;
    }

    updateYearDisplay();
    updateSliderRange();
    updateMapLayer();
    if (clickedPoint) updateTimeline(clickedPoint.lat, clickedPoint.lng);
  });
});

function updateSliderRange() {
  const slider = document.getElementById("year-slider");
  slider.min = 1980;
  slider.max = activeScenario === "historical" ? 2014 : 2100;
}

// ── YEAR SLIDER ───────────────────────────────────────────────

document.getElementById("year-slider").addEventListener("input", e => {
  activeYear = parseInt(e.target.value);
  updateYearDisplay();
  updateMapLayer();
});

function updateYearDisplay() {
  document.getElementById("year-label").textContent = activeYear;
}

// ── PLAY ──────────────────────────────────────────────────────

const playBtn = document.getElementById("play-btn");
playBtn.addEventListener("click", () => isPlaying ? stopPlay() : startPlay());

function startPlay() {
  isPlaying = true;
  playBtn.innerHTML = "&#9646;&#9646;";
  playBtn.classList.add("playing");

  const maxYear = activeScenario === "historical" ? 2014 : 2100;
  if (activeYear >= maxYear) {
    activeYear = 1980;
    document.getElementById("year-slider").value = 1980;
  }

  preloadFrames(activeYear, 8);

  playTimer = setInterval(() => {
    activeYear++;
    const max = activeScenario === "historical" ? 2014 : 2100;
    if (activeYear > max) { stopPlay(); return; }
    document.getElementById("year-slider").value = activeYear;
    updateYearDisplay();
    updateMapLayer();
    preloadFrames(activeYear, 6);
  }, PLAY_INTERVAL_MS);
}

function stopPlay() {
  isPlaying = false;
  playBtn.innerHTML = "&#9654;";
  playBtn.classList.remove("playing");
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
}

// ── BASEMAP TOGGLE ────────────────────────────────────────────

document.getElementById("basemap-toggle").addEventListener("click", (e) => {
  e.stopPropagation();
  document.getElementById("basemap-dropdown").classList.toggle("hidden");
});

document.querySelectorAll(".basemap-opt").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".basemap-opt").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeBasemap = btn.dataset.basemap;
    if (map.getSource("basemap")) {
      map.getSource("basemap").setTiles([BASEMAP_TILES[activeBasemap]]);
    }
    document.getElementById("basemap-dropdown").classList.add("hidden");
  });
});

// Close dropdown when clicking elsewhere
document.addEventListener("click", () => {
  document.getElementById("basemap-dropdown")?.classList.add("hidden");
});

// ── CLICK MARKER ──────────────────────────────────────────────

function placeMarker(lngLat) {
  if (activeMarker) activeMarker.remove();
  const el = document.createElement("div");
  el.className = "click-marker";
  activeMarker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
}

// ── DISMISS ───────────────────────────────────────────────────

function dismiss() {
  document.getElementById("timeline-panel").classList.add("hidden");
  document.getElementById("click-hint").classList.remove("hidden");
  if (activeMarker) activeMarker.remove();
  activeMarker = null;
  clickedPoint = null;
  revealActive = false;
  clearRevealMask();
  hideRasterLayer();
  closeSidebar();
  map.flyTo({ center: [-119.5, 37.5], zoom: 5.0, duration: 800 });
}

// ── MAP CLICK ─────────────────────────────────────────────────

map.on("click", async e => {
  const lat = e.lngLat.lat;
  const lng = e.lngLat.lng;

  if (lat < CA_BOUNDS.minLat || lat > CA_BOUNDS.maxLat ||
      lng < CA_BOUNDS.minLng || lng > CA_BOUNDS.maxLng) return;

  if (!revealActive) {
    showRasterLayer();
    revealActive = true;
  }

  // Auto-close sidebar on new click
  if (sidebarOpen) closeSidebar();

  updateRevealMask(lng, lat);
  map.easeTo({ center: [lng, lat], zoom: REVEAL_ZOOM, duration: 600 });

  placeMarker(e.lngLat);
  clickedPoint = { lat, lng };
  document.getElementById("click-hint").classList.add("hidden");
  document.getElementById("timeline-panel").classList.remove("hidden");
  await updateTimeline(lat, lng);
});

// ── CHART DATA FETCHING ───────────────────────────────────────

async function fetchChartData(metric) {
  if (chartDataCache[metric] && chartDataCache[metric] !== "loading") {
    return chartDataCache[metric];
  }

  if (chartDataCache[metric] === "loading") {
    return new Promise((resolve) => {
      const poll = setInterval(() => {
        if (chartDataCache[metric] !== "loading") {
          clearInterval(poll);
          resolve(chartDataCache[metric] || null);
        }
      }, 100);
    });
  }

  chartDataCache[metric] = "loading";
  try {
    const url  = `${PNG_BASE}/pngs/${metric}/chart_data.json`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    chartDataCache[metric] = data;
    return data;
  } catch (err) {
    console.error(`Failed to load chart_data.json for ${metric}:`, err);
    chartDataCache[metric] = null;
    return null;
  }
}

// ── NEAREST POINT LOOKUP ──────────────────────────────────────

function findNearestPointIndex(clickLat, clickLng, lats, lons) {
  let bestIdx  = 0;
  let bestDist = Infinity;

  for (let i = 0; i < lats.length; i++) {
    const dlat = lats[i] - clickLat;
    const dlon = lons[i] - clickLng;
    const dist = dlat * dlat + dlon * dlon;
    if (dist < bestDist) {
      bestDist = bestIdx = 0;
      bestDist = dist;
      bestIdx  = i;
    }
  }

  return bestIdx;
}

// ── TIMELINE ──────────────────────────────────────────────────

document.getElementById("timeline-close").addEventListener("click", dismiss);

async function updateTimeline(lat, lng) {
  if (!metadata) return;
  const cfg = metadata.metrics[activeMetric];
  if (!cfg) return;

  document.getElementById("timeline-location").textContent =
    `${lat.toFixed(3)}° N, ${Math.abs(lng).toFixed(3)}° W`;
  document.getElementById("timeline-meta").textContent =
    `${cfg.label} · ${metadata.scenarios[activeScenario]?.label || activeScenario}`;

  showChartLoading();

  const chartData = await fetchChartData(activeMetric);

  if (!chartData) {
    showChartError();
    return;
  }

  const pointIdx = findNearestPointIndex(lat, lng, chartData.lats, chartData.lons);
  buildTimelineChart(cfg, chartData, pointIdx);

  // If sidebar is open, refresh it with the new point's data
  if (sidebarOpen) {
    updateSidebarContent(chartData, pointIdx);
  }
}

function showChartLoading() {
  const canvas = document.getElementById("timeline-chart");
  if (timelineChart) { timelineChart.destroy(); timelineChart = null; }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#4d7a96";
  ctx.font      = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Loading chart data...", canvas.width / 2, canvas.height / 2);
}

function showChartError() {
  const canvas = document.getElementById("timeline-chart");
  if (timelineChart) { timelineChart.destroy(); timelineChart = null; }
  const ctx    = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#4d7a96";
  ctx.font      = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Chart data unavailable", canvas.width / 2, canvas.height / 2);
}

// ── CHART BUILDER ─────────────────────────────────────────────

function buildTimelineChart(cfg, chartData, pointIdx) {
  const canvas = document.getElementById("timeline-chart");
  if (timelineChart) { timelineChart.destroy(); timelineChart = null; }

  const histYears = chartData.hist_years;
  const futYears  = chartData.fut_years;
  const allYears  = [...histYears, ...futYears];

  const histMean  = (chartData.historical?.mean?.[pointIdx]) || [];
  const scenData  = chartData[activeScenario] || {};
  const futMedian = scenData.median?.[pointIdx] || [];
  const futP10    = scenData.p10?.[pointIdx]    || [];
  const futP90    = scenData.p90?.[pointIdx]    || [];

  const histLen  = histYears.length;
  const futLen   = futYears.length;

  const histLine = [...histMean.map(v => v), ...Array(futLen).fill(null)];
  const futLine  = [...Array(histLen).fill(null), ...futMedian.map(v => v)];
  const p10Line  = [...Array(histLen).fill(null), ...futP10.map(v => v)];
  const p90Line  = [...Array(histLen).fill(null), ...futP90.map(v => v)];

  const scenarioColor = metadata.scenarios[activeScenario]?.color || "#3ecfcf";

  const datasets = [];

  datasets.push({
    label: "p90",
    data: p90Line,
    borderColor: "transparent",
    backgroundColor: hexToRgba(scenarioColor, 0.12),
    pointRadius: 0,
    fill: "+1",
    tension: 0.3,
    order: 3,
  });

  datasets.push({
    label: "p10",
    data: p10Line,
    borderColor: "transparent",
    backgroundColor: "transparent",
    pointRadius: 0,
    fill: false,
    tension: 0.3,
    order: 3,
  });

  datasets.push({
    label: metadata.scenarios[activeScenario]?.label || activeScenario,
    data: futLine,
    borderColor: scenarioColor,
    borderWidth: 1.5,
    pointRadius: 0,
    fill: false,
    tension: 0.3,
    order: 2,
  });

  datasets.push({
    label: "Historical",
    data: histLine,
    borderColor: "#3ecfcf",
    borderWidth: 1.5,
    pointRadius: 0,
    fill: false,
    tension: 0.3,
    order: 2,
  });

  if (activeMetric === "wine_grapes_gdd") {
    if (cfg.viability_line_low != null) {
      datasets.push({
        label: "Lower limit",
        data: allYears.map(() => cfg.viability_line_low),
        borderColor: "rgba(245,158,58,0.55)",
        borderWidth: 1,
        borderDash: [4, 4],
        pointRadius: 0,
        fill: false,
        order: 1,
      });
    }
    if (cfg.viability_line_high != null) {
      datasets.push({
        label: "Upper limit",
        data: allYears.map(() => cfg.viability_line_high),
        borderColor: "rgba(248,113,113,0.55)",
        borderWidth: 1,
        borderDash: [4, 4],
        pointRadius: 0,
        fill: false,
        order: 1,
      });
    }
  } else if (cfg.viability_line != null) {
    datasets.push({
      label: "Viability threshold",
      data: allYears.map(() => cfg.viability_line),
      borderColor: "rgba(245,158,58,0.6)",
      borderWidth: 1,
      borderDash: [4, 4],
      pointRadius: 0,
      fill: false,
      order: 1,
    });
  }

  timelineChart = new Chart(canvas, {
    type: "line",
    data: { labels: allYears, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(12,31,44,0.92)",
          titleColor: "#3ecfcf",
          bodyColor: "#8ab4c8",
          borderColor: "rgba(62,207,207,0.2)",
          borderWidth: 1,
          padding: 8,
          callbacks: {
            title: (items) => `${items[0].label}`,
            label: (item) => {
              if (item.dataset.label === "p90" || item.dataset.label === "p10") return null;
              const v = item.raw;
              if (v === null || v === undefined) return null;
              return `${item.dataset.label}: ${formatValue(v, cfg)}`;
            },
          },
          filter: (item) => item.dataset.label !== "p90" && item.dataset.label !== "p10",
        },
      },
      scales: {
        x: {
          display: true,
          ticks: { color: "#4d7a96", font: { size: 9 }, maxTicksLimit: 7, maxRotation: 0 },
          grid: { color: "rgba(255,255,255,0.03)" },
        },
        y: {
          display: true,
          title: { display: true, text: cfg.chart_label, color: "#4d7a96", font: { size: 9 } },
          ticks: { color: "#4d7a96", font: { size: 9 }, maxTicksLimit: 5 },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
      },
    },
  });
}

// ── INTERPRETATION SIDEBAR ────────────────────────────────────

document.getElementById("interpret-btn").addEventListener("click", async () => {
  if (!clickedPoint) return;
  openSidebar();
});

document.getElementById("sidebar-close").addEventListener("click", closeSidebar);

function openSidebar() {
  sidebarOpen = true;
  const sidebar = document.getElementById("interpret-sidebar");
  sidebar.classList.remove("hidden");
  // Trigger slide-in animation
  requestAnimationFrame(() => sidebar.classList.add("open"));
  updateSidebarContent();
}

function closeSidebar() {
  sidebarOpen = false;
  const sidebar = document.getElementById("interpret-sidebar");
  sidebar.classList.remove("open");
  // Wait for animation to finish before hiding
  sidebar.addEventListener("transitionend", () => {
    if (!sidebarOpen) sidebar.classList.add("hidden");
  }, { once: true });
}

// ── PDF EXPORT ────────────────────────────────────────────────

document.getElementById("export-pdf-btn").addEventListener("click", function () {
  const btn = this;
  if (!clickedPoint || !metadata) return;

  btn.disabled    = true;
  btn.textContent = "Generating PDF...";

  const cfg       = metadata.metrics[activeMetric];
  const ctxData   = METRIC_CONTEXT[activeMetric];
  const scenLabel = metadata.scenarios[activeScenario]?.label || activeScenario;
  const generated = new Date().toLocaleString();

  // Grab chart image before building print element
  const chartCanvas = document.getElementById("timeline-chart");
  const chartImgSrc = (timelineChart && chartCanvas)
    ? chartCanvas.toDataURL("image/png")
    : null;

  // Get current status info from sidebar
  const statusTxt   = document.getElementById("sidebar-status-text")?.textContent || "";
  const currentVal  = document.getElementById("sidebar-current-value")?.textContent || "";
  const trendText   = document.getElementById("sidebar-trend")?.textContent || "";
  const whatText    = ctxData?.what || "";
  const riskText    = ctxData?.risk_note || "";

  const statusEl    = document.getElementById("sidebar-status-badge");
  let statusColor   = "#7a9ab0";
  if (statusEl?.classList.contains("status-green")) statusColor = "#16a34a";
  if (statusEl?.classList.contains("status-amber")) statusColor = "#d97706";
  if (statusEl?.classList.contains("status-red"))   statusColor = "#dc2626";

  // Build print DOM — real elements, not innerHTML strings, so html2pdf renders fully
  const printEl = document.createElement("div");
  printEl.style.cssText = "font-family:Arial,sans-serif;color:#111;background:#fff;padding:24px;max-width:660px;";
  function section(labelText, contentEl) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-bottom:14px;padding:12px;border:1px solid #ddd;border-radius:8px;background:#f9f9f9;";
    const label = document.createElement("div");
    label.style.cssText = "font-size:10px;font-weight:600;color:#6a8fa8;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px;";
    label.textContent = labelText;
    wrap.appendChild(label);
    wrap.appendChild(contentEl);
    return wrap;
  }

  function para(text) {
    const p = document.createElement("p");
    p.style.cssText = "font-size:12px;color:#334155;margin:0;line-height:1.6;";
    p.textContent = text;
    return p;
  }

  // Header
  const header = document.createElement("div");
  header.innerHTML = `
    <h1 style="margin:0 0 4px;font-size:18px;color:#0c1f2c;">Remnant Biome - Climate Viability Report</h1>
    <p style="margin:0 0 2px;font-size:12px;color:#555;">${clickedPoint.lat.toFixed(4)}° N, ${Math.abs(clickedPoint.lng).toFixed(4)}° W</p>
    <p style="margin:0 0 2px;font-size:11px;color:#888;">${cfg?.label || activeMetric} &middot; ${scenLabel} &middot; ${activeYear}</p>
    <p style="margin:0 0 16px;font-size:11px;color:#888;">Generated: ${generated}</p>
    <hr style="border:none;border-top:1px solid #ddd;margin-bottom:16px;">
  `;
  printEl.appendChild(header);

  // Status block
  const statusBlock = document.createElement("div");
  statusBlock.style.cssText = "display:flex;align-items:center;gap:16px;margin-bottom:14px;padding:12px;border:1px solid #ddd;border-radius:8px;background:#f9f9f9;";
  statusBlock.innerHTML = `
    <div style="padding:6px 16px;border-radius:20px;border:1px solid ${statusColor};background:${statusColor}22;color:${statusColor};font-size:13px;font-weight:600;">${statusTxt}</div>
    <div>
      <div style="font-size:22px;font-weight:600;color:#0c1f2c;">${currentVal}</div>
      <div style="font-size:11px;color:#7a9ab0;">in ${activeYear}</div>
    </div>
  `;
  printEl.appendChild(statusBlock);

  // Projected change
  printEl.appendChild(section("Projected Change", para(trendText)));

  // Chart image
  if (chartImgSrc) {
    const chartWrap = document.createElement("div");
    chartWrap.style.cssText = "margin-bottom:14px;padding:12px;border:1px solid #ddd;border-radius:8px;";
    const chartLabel = document.createElement("div");
    chartLabel.style.cssText = "font-size:10px;font-weight:600;color:#6a8fa8;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px;";
    chartLabel.textContent = "1980-2100 Timeline";
    const chartImg = document.createElement("img");
    chartImg.src = chartImgSrc;
    chartImg.style.cssText = "width:100%;border-radius:4px;display:block;";
    chartWrap.appendChild(chartLabel);
    chartWrap.appendChild(chartImg);
    printEl.appendChild(chartWrap);
  }

  // What this measures
  printEl.appendChild(section("What This Measures", para(whatText)));

  // Why it matters
  printEl.appendChild(section("Why It Matters", para(riskText)));

  // Footer
  const footer = document.createElement("div");
  footer.style.cssText = "margin-top:20px;padding-top:12px;border-top:1px solid #ddd;text-align:center;";
  footer.innerHTML = `
    <div style="font-size:10px;color:#9ca3af;">Remnant Biome &middot; lesselgeospatial.com &middot; Powered by LOCA2-Hybrid CA (CMIP6, 3km)</div>
    <div style="font-size:9px;color:#bbb;margin-top:4px;">For informational and educational purposes only. Not intended for professional agricultural, legal, or financial decision-making. No warranty on accuracy.</div>
  `;
  printEl.appendChild(footer);

  // html2pdf requires the element to be in the DOM with static positioning
  // Using a hidden wrapper div avoids position:fixed/absolute blank render bug
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "overflow:hidden;height:0;width:680px;";
  wrapper.appendChild(printEl);
  document.body.appendChild(wrapper);

  const opt = {
    margin:      [10, 10, 10, 10],
    filename:    `remnant-biome-report-${Date.now()}.pdf`,
    image:       { type: "jpeg", quality: 0.92 },
    html2canvas: { scale: 1, useCORS: true, backgroundColor: "#ffffff", logging: false },
    jsPDF:       { unit: "mm", format: "a4", orientation: "portrait" },
  };

  html2pdf().set(opt).from(printEl).save()
    .finally(() => {
      document.body.removeChild(wrapper);
      btn.disabled    = false;
      btn.textContent = "\u2B07 Export PDF Report";
    });
});

async function updateSidebarContent(cachedData, cachedIdx) {
  if (!clickedPoint || !metadata) return;

  const cfg     = metadata.metrics[activeMetric];
  const ctx     = METRIC_CONTEXT[activeMetric];
  if (!cfg || !ctx) return;

  // ── Header ────────────────────────────────────────────────
  document.getElementById("sidebar-metric-name").textContent = cfg.label;
  document.getElementById("sidebar-location").textContent =
    `${clickedPoint.lat.toFixed(3)}° N, ${Math.abs(clickedPoint.lng).toFixed(3)}° W`;

  // ── Category tag ──────────────────────────────────────────
  const catEl = document.getElementById("sidebar-category");
  const isCrop = cfg.category === "crop";
  catEl.textContent = isCrop ? "Crop" : "Pest";
  catEl.className   = "sidebar-category-tag " + (isCrop ? "tag-crop" : "tag-pest");

  // ── Status badge (uses current year's data) ───────────────
  await updateSidebarStatus(cfg, cachedData, cachedIdx);

  // ── Static agronomic context ──────────────────────────────
  document.getElementById("sidebar-what").textContent      = ctx.what;
  document.getElementById("sidebar-risk").textContent      = ctx.risk_note;

  // ── Trend sentence (uses chart data for the point) ────────
  await buildTrendSentence(cfg, ctx, cachedData, cachedIdx);
}

async function updateSidebarStatus(cfg, cachedData, cachedIdx) {
  const statusEl  = document.getElementById("sidebar-status-badge");
  const statusTxt = document.getElementById("sidebar-status-text");
  const valueEl   = document.getElementById("sidebar-current-value");

  // Try to get the value for the current year at this point
  let chartData = cachedData;
  let pointIdx  = cachedIdx;

  if (!chartData || pointIdx == null) {
    chartData = await fetchChartData(activeMetric);
    if (!chartData || !clickedPoint) { statusEl.className = "sidebar-status-badge"; return; }
    pointIdx = findNearestPointIndex(clickedPoint.lat, clickedPoint.lng, chartData.lats, chartData.lons);
  }

  const value = getValueForYear(chartData, pointIdx, activeYear, activeScenario);
  if (value == null) { statusEl.className = "sidebar-status-badge"; return; }

  const { label, color, cssClass } = classifyValue(value, cfg);

  statusEl.className = `sidebar-status-badge ${cssClass}`;
  statusTxt.textContent = label;
  valueEl.textContent   = formatValue(value, cfg);
  const yearDisplay = document.getElementById("sidebar-year-display");
  if (yearDisplay) yearDisplay.textContent = activeYear;
}

async function buildTrendSentence(cfg, ctx, cachedData, cachedIdx) {
  const trendEl = document.getElementById("sidebar-trend");

  let chartData = cachedData;
  let pointIdx  = cachedIdx;

  if (!chartData || pointIdx == null) {
    chartData = await fetchChartData(activeMetric);
    if (!chartData || !clickedPoint) { trendEl.textContent = ""; return; }
    pointIdx = findNearestPointIndex(clickedPoint.lat, clickedPoint.lng, chartData.lats, chartData.lons);
  }

  if (activeScenario === "historical") {
    // For historical, compare 1980 to 2014
    const v1980 = getValueForYear(chartData, pointIdx, 1980, "historical");
    const v2014 = getValueForYear(chartData, pointIdx, 2014, "historical");
    if (v1980 == null || v2014 == null) { trendEl.textContent = ""; return; }
    const pct  = Math.round(Math.abs((v2014 - v1980) / v1980) * 100);
    const dir  = v2014 > v1980 ? "increased" : "decreased";
    trendEl.textContent =
      `Between 1980 and 2014, ${cfg.label.toLowerCase()} at this location ${dir} by ${pct}%, from ${formatValue(v1980, cfg)} to ${formatValue(v2014, cfg)}.`;
    return;
  }

  // For future scenarios, compare 2026 to 2100
  const scenData = chartData[activeScenario];
  if (!scenData?.median?.[pointIdx]) { trendEl.textContent = ""; return; }

  const startYear = 2026;
  const endYear   = 2100;
  const vStart    = getValueForYear(chartData, pointIdx, startYear, activeScenario);
  const vEnd      = getValueForYear(chartData, pointIdx, endYear,   activeScenario);

  if (vStart == null || vEnd == null) { trendEl.textContent = ""; return; }

  const pct = Math.round(Math.abs((vEnd - vStart) / Math.max(vStart, 1)) * 100);
  const dir = vEnd > vStart ? "rise" : "fall";
  const scenLabel = metadata.scenarios[activeScenario]?.label || activeScenario;

  trendEl.textContent =
    `Under ${scenLabel}, ${cfg.label.toLowerCase()} here are projected to ${dir} from ${formatValue(vStart, cfg)} in ${startYear} to ${formatValue(vEnd, cfg)} by ${endYear}, a ${pct}% change.`;
}

// ── VALUE LOOKUP HELPER ───────────────────────────────────────
// Given chart data and a point index, returns the metric value
// for a specific year and scenario.

function getValueForYear(chartData, pointIdx, year, scenario) {
  if (year <= 2014) {
    // Historical period
    const idx = chartData.hist_years?.indexOf(year);
    if (idx == null || idx < 0) return null;
    return chartData.historical?.mean?.[pointIdx]?.[idx] ?? null;
  } else {
    // Future period
    const idx = chartData.fut_years?.indexOf(year);
    if (idx == null || idx < 0) return null;
    return chartData[scenario]?.median?.[pointIdx]?.[idx] ?? null;
  }
}

// ── VALUE CLASSIFICATION ──────────────────────────────────────
// Determines green/amber/red status from metric value + config thresholds.

function classifyValue(value, cfg) {
  const t   = cfg.thresholds || {};
  const dir = cfg.direction;

  if (dir === "higher_is_better") {
    if (value >= t.green_min) return { label: "Fully viable",  color: "#4ade80", cssClass: "status-green" };
    if (value >= t.amber_min) return { label: "Marginal",      color: "#f59e3a", cssClass: "status-amber" };
    return                           { label: "Deficit",       color: "#f87171", cssClass: "status-red"   };

  } else if (dir === "lower_is_better") {
    if (value <= t.green_max) return { label: "Low risk",      color: "#4ade80", cssClass: "status-green" };
    if (value <= t.amber_max) return { label: "Moderate risk", color: "#f59e3a", cssClass: "status-amber" };
    return                           { label: "High risk",     color: "#f87171", cssClass: "status-red"   };

  } else if (dir === "middle_is_better") {
    if (value >= t.green_min && value <= t.green_max)
      return { label: "Ideal range",  color: "#4ade80", cssClass: "status-green" };
    if ((value >= t.amber_low_min  && value <= t.amber_low_max) ||
        (value >= t.amber_high_min && value <= t.amber_high_max))
      return { label: "Marginal",     color: "#f59e3a", cssClass: "status-amber" };
    return   { label: "Out of range", color: "#f87171", cssClass: "status-red"   };
  }

  return { label: "Unknown", color: "#7a9ab0", cssClass: "" };
}

// ── HELPERS ───────────────────────────────────────────────────

function formatValue(v, cfg) {
  if (v === null || v === undefined) return "–";
  const rounded = Math.round(v * 10) / 10;
  return `${rounded} ${cfg.units}`;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── DEFICIT BADGE ─────────────────────────────────────────────
// Removed - covered by interpretation sidebar status badge

function checkDeficitBadge() {}

// ── ABOUT ─────────────────────────────────────────────────────

document.getElementById("about-toggle").addEventListener("click", () => {
  document.getElementById("about-panel").classList.toggle("hidden");
});

// ── KEYBOARD ──────────────────────────────────────────────────

document.addEventListener("keydown", e => {
  const max = activeScenario === "historical" ? 2014 : 2100;
  if (e.key === "ArrowRight" || e.key === "ArrowUp") {
    if (activeYear < max) {
      activeYear++;
      document.getElementById("year-slider").value = activeYear;
      updateYearDisplay(); updateMapLayer();
    }
  } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
    if (activeYear > 1980) {
      activeYear--;
      document.getElementById("year-slider").value = activeYear;
      updateYearDisplay(); updateMapLayer();
    }
  } else if (e.key === " ") {
    e.preventDefault();
    isPlaying ? stopPlay() : startPlay();
  } else if (e.key === "Escape") {
    if (sidebarOpen) closeSidebar();
    else dismiss();
  }
});

// ── PILL TOOLTIPS ─────────────────────────────────────────────

let tooltipHideTimer = null;

function createTooltipEl() {
  const el = document.createElement("div");
  el.id = "pill-tooltip";
  el.innerHTML = `
    <div id="pill-tooltip-title"></div>
    <div id="pill-tooltip-desc"></div>
    <div id="pill-tooltip-colors"></div>
  `;
  document.body.appendChild(el);
  return el;
}

const tooltipEl = createTooltipEl();

function buildColorRows(cfg) {
  const t   = cfg.thresholds || {};
  const u   = cfg.units || "";
  const dir = cfg.direction;
  const rows = [];

  if (dir === "higher_is_better") {
    rows.push({ color: "#4ade80", label: `${t.green_min}+ ${u}: fully viable` });
    rows.push({ color: "#f59e3a", label: `${t.amber_min}–${t.green_min} ${u}: marginal` });
    rows.push({ color: "#f87171", label: `Under ${t.amber_min} ${u}: deficit` });
  } else if (dir === "lower_is_better") {
    rows.push({ color: "#4ade80", label: `${t.green_max} ${u}: fully viable` });
    rows.push({ color: "#f59e3a", label: `${t.green_max + 1}–${t.amber_max} ${u}: marginal` });
    rows.push({ color: "#f87171", label: `Over ${t.amber_max} ${u}: high risk` });
  } else if (dir === "middle_is_better") {
    rows.push({ color: "#4ade80", label: `${t.green_min}–${t.green_max} ${u}: ideal range` });
    rows.push({ color: "#f59e3a", label: `${t.amber_low_min}–${t.amber_low_max} or ${t.amber_high_min}–${t.amber_high_max} ${u}: marginal` });
    rows.push({ color: "#f87171", label: `Under ${t.red_low_max} or over ${t.red_high_min} ${u}: outside viable range` });
  }

  return rows;
}

function showTooltip(pill, metricKey) {
  if (!metadata) return;
  const cfg = metadata.metrics[metricKey];
  if (!cfg) return;

  clearTimeout(tooltipHideTimer);

  document.getElementById("pill-tooltip-title").textContent = cfg.label;
  document.getElementById("pill-tooltip-desc").textContent  = cfg.description;

  const colorsEl = document.getElementById("pill-tooltip-colors");
  colorsEl.innerHTML = "";
  buildColorRows(cfg).forEach(({ color, label }) => {
    const row = document.createElement("div");
    row.className = "tooltip-color-row";
    row.innerHTML = `
      <div class="tooltip-swatch" style="background:${color}"></div>
      <span>${label}</span>
    `;
    colorsEl.appendChild(row);
  });

  const rect   = pill.getBoundingClientRect();
  const tipW   = 240;
  const margin = 8;

  let left = rect.left + (rect.width / 2) - (tipW / 2);
  left = Math.max(margin, Math.min(left, window.innerWidth - tipW - margin));

  tooltipEl.style.left  = `${left}px`;
  tooltipEl.style.width = `${tipW}px`;
  tooltipEl.style.top   = `-9999px`;
  tooltipEl.classList.add("visible");

  requestAnimationFrame(() => {
    const tipH = tooltipEl.offsetHeight;
    let top = rect.top - tipH - 8;
    if (top < margin) top = rect.bottom + 8;
    tooltipEl.style.top = `${top}px`;
  });
}

function hideTooltip(delay = 120) {
  tooltipHideTimer = setTimeout(() => {
    tooltipEl.classList.remove("visible");
  }, delay);
}

function initPillTooltips() {
  document.querySelectorAll(".pill").forEach(pill => {
    const metricKey = pill.dataset.metric;
    pill.addEventListener("mouseenter", () => showTooltip(pill, metricKey));
    pill.addEventListener("mouseleave", () => hideTooltip(120));
    pill.addEventListener("touchend", (e) => {
      const isVisible  = tooltipEl.classList.contains("visible");
      const wasThisPill = tooltipEl._activePill === pill;
      hideTooltip(0);
      if (!isVisible || !wasThisPill) {
        e.preventDefault();
        tooltipEl._activePill = pill;
        showTooltip(pill, metricKey);
      }
    });
  });

  document.addEventListener("touchstart", (e) => {
    if (!e.target.closest(".pill")) hideTooltip(0);
  });
}

const _tooltipInitInterval = setInterval(() => {
  if (metadata) {
    clearInterval(_tooltipInitInterval);
    initPillTooltips();
  }
}, 200);

// ── SCENARIO TOOLTIPS ─────────────────────────────────────────

const SCENARIO_TOOLTIPS = {
  "historical": {
    title: "Historical (1980–2014)",
    desc:  "Real observed climate data. No projections, this is what actually happened.",
  },
  "ssp245": {
    title: "Current Policy - SSP2-4.5",
    desc:  "A middle-of-the-road future where some climate policies are enacted but emissions don't fall fast. Roughly where the world is headed today.",
  },
  "ssp370": {
    title: "High Emissions - SSP3-7.0",
    desc:  "A future with limited climate action and continued heavy fossil fuel use. Regional conflicts and slow international cooperation.",
  },
  "ssp585": {
    title: "Worst Case - SSP5-8.5",
    desc:  "Maximum fossil fuel development with no meaningful emissions limits. Considered an unlikely but physically possible upper bound.",
  },
};

(function initScenarioTooltips() {
  const tipEl = document.createElement("div");
  tipEl.id = "scenario-tooltip";
  tipEl.innerHTML = `
    <div id="scenario-tooltip-title"></div>
    <div id="scenario-tooltip-desc"></div>
  `;
  document.body.appendChild(tipEl);

  let hideTimer = null;

  function showScenarioTooltip(btn, scenarioKey) {
    const data = SCENARIO_TOOLTIPS[scenarioKey];
    if (!data) return;

    clearTimeout(hideTimer);

    document.getElementById("scenario-tooltip-title").textContent = data.title;
    document.getElementById("scenario-tooltip-desc").textContent  = data.desc;

    const rect   = btn.getBoundingClientRect();
    const tipW   = 200;
    const margin = 8;

    let left = rect.left + (rect.width / 2) - (tipW / 2);
    left = Math.max(margin, Math.min(left, window.innerWidth - tipW - margin));

    tipEl.style.left  = `${left}px`;
    tipEl.style.width = `${tipW}px`;
    tipEl.style.top   = `-9999px`;
    tipEl.classList.add("visible");

    requestAnimationFrame(() => {
      const tipH = tipEl.offsetHeight;
      let top = rect.top - tipH - 8;
      if (top < margin) top = rect.bottom + 8;
      tipEl.style.top = `${top}px`;
    });
  }

  function hideScenarioTooltip(delay = 120) {
    hideTimer = setTimeout(() => {
      tipEl.classList.remove("visible");
    }, delay);
  }

  document.querySelectorAll(".scenario-btn").forEach(btn => {
    const key = btn.dataset.scenario;
    btn.addEventListener("mouseenter", () => showScenarioTooltip(btn, key));
    btn.addEventListener("mouseleave", () => hideScenarioTooltip(120));
    btn.addEventListener("touchend", (e) => {
      const isVisible  = tipEl.classList.contains("visible");
      const wasThisBtn = tipEl._activeBtn === btn;
      hideScenarioTooltip(0);
      if (!isVisible || !wasThisBtn) {
        e.preventDefault();
        tipEl._activeBtn = btn;
        showScenarioTooltip(btn, key);
      }
    });
  });

  document.addEventListener("touchstart", (e) => {
    if (!e.target.closest(".scenario-btn")) hideScenarioTooltip(0);
  });
})();

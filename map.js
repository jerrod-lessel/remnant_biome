/* ============================================================
   Remnant Biome — map.js
============================================================ */

const PNG_BASE = "";

const CA_BOUNDS = {
  minLat: 32.5, maxLat: 42.1,
  minLng: -124.5, maxLng: -114.1,
};

const PLAY_INTERVAL_MS = 325;

// Tuned bounds — shifted south to correct display offset
const IMG_BOUNDS = [-128.4375, 29.18, -110.9688, 44.68];

// Reveal circle settings
const REVEAL_RADIUS_MILES = 25;
const REVEAL_ZOOM         = 8;

// Outer bbox for the donut dark fill — well beyond CA + PNG spillover
const DONUT_BBOX = [-140, 22, -100, 52];

// Fringe rings — annuli just outside the hole, getting darker outward
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

// ── CHART DATA CACHE ──────────────────────────────────────────
// Holds fetched chart_data.json per metric so we only fetch once each.
// Key = metric name, value = parsed JSON object (or "loading" sentinel).
const chartDataCache = {};

// ── IMAGE PRELOAD CACHE ───────────────────────────────────────
// Browser caches the actual image files; we just need to fire new Image()
// to trigger the fetch. Keeping handles here prevents GC from evicting them.
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
  zoom: 5.5,
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
// During playback, fire off fetches for the next several frames
// before they're needed. The browser caches them so updateMapLayer()
// finds them ready. We keep Image handles in preloadedImages so the
// GC doesn't evict them before they finish loading.

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
  map.flyTo({ center: [-119.5, 37.5], zoom: 5.5, duration: 800 })
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

  // Kick off an initial preload batch before the first tick
  preloadFrames(activeYear, 8);

  playTimer = setInterval(() => {
    activeYear++;
    const max = activeScenario === "historical" ? 2014 : 2100;
    if (activeYear > max) { stopPlay(); return; }
    document.getElementById("year-slider").value = activeYear;
    updateYearDisplay();
    updateMapLayer();
    // Preload the next several frames on every tick
    preloadFrames(activeYear, 6);
  }, PLAY_INTERVAL_MS);
}

function stopPlay() {
  isPlaying = false;
  playBtn.innerHTML = "&#9654;";
  playBtn.classList.remove("playing");
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
}

// ── BASEMAP ───────────────────────────────────────────────────

document.querySelectorAll(".basemap-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".basemap-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeBasemap = btn.dataset.basemap;
    if (map.getSource("basemap")) {
      map.getSource("basemap").setTiles([BASEMAP_TILES[activeBasemap]]);
    }
  });
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
  map.flyTo({ center: [-119.5, 37.5], zoom: 5.5, duration: 800 });
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

  updateRevealMask(lng, lat);
  map.easeTo({ center: [lng, lat], zoom: REVEAL_ZOOM, duration: 600 });

  placeMarker(e.lngLat);
  clickedPoint = { lat, lng };
  document.getElementById("click-hint").classList.add("hidden");
  document.getElementById("timeline-panel").classList.remove("hidden");
  await updateTimeline(lat, lng);
});

// ── CHART DATA FETCHING ───────────────────────────────────────
// Fetches chart_data.json for the active metric, using an in-memory cache
// so each metric is only downloaded once per session.

async function fetchChartData(metric) {
  // Already cached and loaded
  if (chartDataCache[metric] && chartDataCache[metric] !== "loading") {
    return chartDataCache[metric];
  }

  // Already in flight — wait for it
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

  // First request — fetch and cache
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
// Given a clicked lat/lng and the grid of sampled points, find the index
// of the nearest sampled point. Uses squared Euclidean distance — fast
// enough for ~3,500 points with no need for a spatial index.

function findNearestPointIndex(clickLat, clickLng, lats, lons) {
  let bestIdx  = 0;
  let bestDist = Infinity;

  for (let i = 0; i < lats.length; i++) {
    const dlat = lats[i] - clickLat;
    const dlon = lons[i] - clickLng;
    const dist = dlat * dlat + dlon * dlon;
    if (dist < bestDist) {
      bestDist = bestIdx = 0; // reset — assign below
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

  // Show a loading state on the chart while we fetch
  showChartLoading();

  // Fetch chart data (cached after first load)
  const chartData = await fetchChartData(activeMetric);

  if (!chartData) {
    showChartError();
    return;
  }

  // Find the nearest pre-sampled grid point to the click
  const pointIdx = findNearestPointIndex(lat, lng, chartData.lats, chartData.lons);

  buildTimelineChart(cfg, chartData, pointIdx);
}

function showChartLoading() {
  const canvas = document.getElementById("timeline-chart");
  if (timelineChart) { timelineChart.destroy(); timelineChart = null; }
  // Brief loading label — the fetch is usually fast from cache
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
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
// Assembles the full 1980-2100 dataset for the nearest point and
// renders a Chart.js line chart with:
//   - Historical period: solid teal line (ensemble mean)
//   - Future period: solid line per scenario (median) + p10/p90 band
//   - Viability threshold: dashed amber line
//   - wine_grapes_gdd: two threshold lines (upper + lower)

function buildTimelineChart(cfg, chartData, pointIdx) {
  const canvas = document.getElementById("timeline-chart");
  if (timelineChart) { timelineChart.destroy(); timelineChart = null; }

  const histYears = chartData.hist_years;   // 1980-2014
  const futYears  = chartData.fut_years;    // 2015-2100
  const allYears  = [...histYears, ...futYears];

  // Pull the value arrays for this point
  const histMean   = (chartData.historical?.mean?.[pointIdx])   || [];

  // Active scenario future data
  const scenData   = chartData[activeScenario] || {};
  const futMedian  = scenData.median?.[pointIdx] || [];
  const futP10     = scenData.p10?.[pointIdx]    || [];
  const futP90     = scenData.p90?.[pointIdx]    || [];

  // Build full-length arrays (null where not applicable)
  // Historical runs 1980-2014, future 2015-2100
  const histLen  = histYears.length;
  const futLen   = futYears.length;
  const totalLen = allYears.length;

  // Historical mean line: values for 1980-2014, null for 2015-2100
  const histLine = [
    ...histMean.map(v => v),
    ...Array(futLen).fill(null),
  ];

  // Future median line: null for 1980-2014, values for 2015-2100
  const futLine = [
    ...Array(histLen).fill(null),
    ...futMedian.map(v => v),
  ];

  // P10/P90 band arrays (full length, null in historical portion)
  const p10Line = [...Array(histLen).fill(null), ...futP10.map(v => v)];
  const p90Line = [...Array(histLen).fill(null), ...futP90.map(v => v)];

  // Scenario color for the future line
  const scenarioColor = metadata.scenarios[activeScenario]?.color || "#3ecfcf";

  // ── Datasets ─────────────────────────────────────────────────
  const datasets = [];

  // P90 upper bound (top of uncertainty band)
  datasets.push({
    label: "p90",
    data: p90Line,
    borderColor: "transparent",
    backgroundColor: hexToRgba(scenarioColor, 0.12),
    pointRadius: 0,
    fill: "+1",          // fill down to p10 (next dataset)
    tension: 0.3,
    order: 3,
  });

  // P10 lower bound (bottom of uncertainty band)
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

  // Future scenario median line
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

  // Historical ensemble mean line
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

  // Viability threshold line(s)
  // wine_grapes_gdd has two thresholds (too cold + too hot)
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

  // ── Chart.js config ──────────────────────────────────────────
  timelineChart = new Chart(canvas, {
    type: "line",
    data: { labels: allYears, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: {
        mode: "index",
        intersect: false,
      },
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
          filter: (item) => {
            return item.dataset.label !== "p90" && item.dataset.label !== "p10";
          },
        },
      },
      scales: {
        x: {
          display: true,
          ticks: {
            color: "#4d7a96",
            font: { size: 9 },
            maxTicksLimit: 7,
            maxRotation: 0,
          },
          grid: { color: "rgba(255,255,255,0.03)" },
        },
        y: {
          display: true,
          title: {
            display: true,
            text: cfg.chart_label,
            color: "#4d7a96",
            font: { size: 9 },
          },
          ticks: { color: "#4d7a96", font: { size: 9 }, maxTicksLimit: 5 },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
      },
    },
  });
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

function checkDeficitBadge() {
  document.getElementById("deficit-badge").classList.add("hidden");
}

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
    dismiss();
  }
});

// ── PILL TOOLTIPS ─────────────────────────────────────────────
// One tooltip element, repositioned on each pill hover.
// Content is generated from metadata.json — no hardcoding per metric.

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
  // Generates plain-English color key rows from metadata thresholds.
  // Handles all three direction types: higher_is_better, lower_is_better,
  // and middle_is_better (wine grapes GDD).
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
    // wine grapes GDD — viable in a middle band, red on both ends
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

  // Populate content
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

  // Position above the pill, centered horizontally
  const rect    = pill.getBoundingClientRect();
  const tipW    = 240;
  const margin  = 8;

  let left = rect.left + (rect.width / 2) - (tipW / 2);
  // Clamp so it doesn't go off screen edges
  left = Math.max(margin, Math.min(left, window.innerWidth - tipW - margin));

  tooltipEl.style.left  = `${left}px`;
  tooltipEl.style.width = `${tipW}px`;

  // Position above the pill; after render we'll know the height
  tooltipEl.style.top = `-9999px`;
  tooltipEl.classList.add("visible");

  // Now measure and place properly above the pill
  requestAnimationFrame(() => {
    const tipH = tooltipEl.offsetHeight;
    let top = rect.top - tipH - 8;
    // If too close to top of screen, flip below the pill instead
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

    // Desktop: hover
    pill.addEventListener("mouseenter", () => showTooltip(pill, metricKey));
    pill.addEventListener("mouseleave", () => hideTooltip(120));

    // Mobile: tap to toggle
    pill.addEventListener("touchend", (e) => {
      const isVisible = tooltipEl.classList.contains("visible");
      const wasThisPill = tooltipEl._activePill === pill;
      hideTooltip(0);
      if (!isVisible || !wasThisPill) {
        e.preventDefault();
        tooltipEl._activePill = pill;
        showTooltip(pill, metricKey);
      }
    });
  });

  // Hide tooltip when clicking anywhere else on mobile
  document.addEventListener("touchstart", (e) => {
    if (!e.target.closest(".pill")) hideTooltip(0);
  });
}

// Init tooltips once metadata is loaded.
// We hook into the existing loadMetadata flow by patching map's load handler.
const _origMapLoad = map.once.bind(map);
map.once("load", async () => {});  // ensure the event fires
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
      const isVisible    = tipEl.classList.contains("visible");
      const wasThisBtn   = tipEl._activeBtn === btn;
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

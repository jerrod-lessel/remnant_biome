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

// Outer bbox for donut mask — well beyond CA + PNG spillover
const DONUT_BBOX = [-140, 22, -100, 52];

// Reveal radius in miles
const REVEAL_RADIUS_MILES = 15;

// Fringe rings: outerMult is fraction of full radius for outer edge,
// opacity is how dark the ring is. Ordered outermost → innermost.
// Inner edge of entire fringe zone = REVEAL_FRINGE_INNER_MULT * radius.
const REVEAL_FRINGE_INNER_MULT = 0.80;
const REVEAL_FRINGE_STEPS = [
  { outerMult: 1.00, opacity: 0.85 },
  { outerMult: 0.95, opacity: 0.65 },
  { outerMult: 0.90, opacity: 0.40 },
  { outerMult: 0.85, opacity: 0.20 },
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

// ── CALIFORNIA MASK (Esri FeatureServer) ──────────────────────

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

    const maskGeojson = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [worldRing, ...caRings],
      },
    };

    map.addSource("ca-mask", {
      type: "geojson",
      data: maskGeojson,
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
      },
    });

    console.log("CA mask added from Esri FeatureServer");

  } catch (e) {
    console.warn("CA mask failed:", e);
  }
}

// ── REVEAL MASK SETUP ─────────────────────────────────────────

function setupRevealLayers() {
  // Empty GeoJSON to start — layers exist but show nothing
  const empty = { type: "FeatureCollection", features: [] };

  // 1. Main donut — dark fill with full-radius hole
  map.addSource("reveal-donut", { type: "geojson", data: empty });
  map.addLayer({
    id: "reveal-donut-layer",
    type: "fill",
    source: "reveal-donut",
    paint: {
      "fill-color": "#0c1f2c",
      "fill-opacity": 1.0,
    },
  });

  // 2. Fringe rings — 4 annuli fading inward
  REVEAL_FRINGE_STEPS.forEach((step, i) => {
    const id = `reveal-fringe-${i}`;
    map.addSource(id, { type: "geojson", data: empty });
    map.addLayer({
      id: `${id}-layer`,
      type: "fill",
      source: id,
      paint: {
        "fill-color": "#0c1f2c",
        "fill-opacity": step.opacity,
      },
    });
  });
}

// ── REVEAL MASK UPDATE ────────────────────────────────────────

function updateRevealMask(lng, lat) {
  const radiusKm = REVEAL_RADIUS_MILES * 1.60934;

  // Full circle at 100% radius — used as the donut hole
  const fullCircle = turfCircle([lng, lat], radiusKm, { steps: 64, units: "kilometers" });

  // Donut: DONUT_BBOX rectangle with full circle punched out as a hole
  const [west, south, east, north] = DONUT_BBOX;
  const bboxRing = [
    [west, south], [east, south], [east, north], [west, north], [west, south]
  ];
  const donutGeojson = {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [bboxRing, fullCircle.geometry.coordinates[0]],
    },
  };
  map.getSource("reveal-donut").setData(donutGeojson);

  // Fringe annuli — each is outerCircle with innerCircle as hole
  const innerRadiusKm = radiusKm * REVEAL_FRINGE_INNER_MULT;

  REVEAL_FRINGE_STEPS.forEach((step, i) => {
    const outerKm = radiusKm * step.outerMult;
    // For the outermost ring, inner edge is REVEAL_FRINGE_INNER_MULT
    // For each subsequent ring, inner edge is the previous ring's outer edge
    const innerKm = i === 0
      ? innerRadiusKm
      : radiusKm * REVEAL_FRINGE_STEPS[i - 1].outerMult;

    const outerCircle = turfCircle([lng, lat], outerKm, { steps: 64, units: "kilometers" });
    const innerCircle = turfCircle([lng, lat], innerKm, { steps: 64, units: "kilometers" });

    const annulusGeojson = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          outerCircle.geometry.coordinates[0],
          innerCircle.geometry.coordinates[0],
        ],
      },
    };
    map.getSource(`reveal-fringe-${i}`).setData(annulusGeojson);
  });
}

function clearRevealMask() {
  const empty = { type: "FeatureCollection", features: [] };
  map.getSource("reveal-donut").setData(empty);
  REVEAL_FRINGE_STEPS.forEach((_, i) => {
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
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
  ];
}

function updateMapLayer() {
  const scenario = getScenarioForYear(activeYear, activeScenario);
  if (!scenario) return;

  const url      = getPngUrl(activeMetric, scenario, activeYear);
  const sourceId = "climate-raster";
  const layerId  = "climate-raster-layer";

  if (map.getLayer(layerId)) {
    const source = map.getSource(sourceId);
    if (source) source.updateImage({ url, coordinates: boundsToCoords(IMG_BOUNDS) });
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
        layout: {
          // Hidden until first click
          visibility: "none",
        },
        paint: {
          "raster-opacity": 0.85,
          "raster-resampling": "nearest",
        },
      },
      map.getLayer("ca-mask-layer") ? "ca-mask-layer" : undefined
    );
  }
}

function showRasterLayer() {
  if (map.getLayer("climate-raster-layer")) {
    map.setLayoutProperty("climate-raster-layer", "visibility", "visible");
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

  playTimer = setInterval(() => {
    activeYear++;
    const max = activeScenario === "historical" ? 2014 : 2100;
    if (activeYear > max) { stopPlay(); return; }
    document.getElementById("year-slider").value = activeYear;
    updateYearDisplay();
    updateMapLayer();
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

// ── MAP CLICK ─────────────────────────────────────────────────

map.on("click", async e => {
  const lat = e.lngLat.lat;
  const lng = e.lngLat.lng;

  if (lat < CA_BOUNDS.minLat || lat > CA_BOUNDS.maxLat ||
      lng < CA_BOUNDS.minLng || lng > CA_BOUNDS.maxLng) return;

  // First click — reveal the raster layer
  if (!revealActive) {
    showRasterLayer();
    revealActive = true;
  }

  // Update the reveal mask to the new click point
  updateRevealMask(lng, lat);

  // Subtle zoom nudge — ease toward click point, cap at zoom 9
  map.easeTo({
    center: [lng, lat],
    zoom: Math.min(map.getZoom() + 1.5, 9),
    duration: 600,
  });

  placeMarker(e.lngLat);
  clickedPoint = { lat, lng };
  document.getElementById("click-hint").classList.add("hidden");
  document.getElementById("timeline-panel").classList.remove("hidden");
  await updateTimeline(lat, lng);
});

// ── TIMELINE ──────────────────────────────────────────────────

document.getElementById("timeline-close").addEventListener("click", () => {
  document.getElementById("timeline-panel").classList.add("hidden");
  if (activeMarker) activeMarker.remove();
  activeMarker = null;
  clickedPoint = null;
});

async function updateTimeline(lat, lng) {
  if (!metadata) return;
  const cfg = metadata.metrics[activeMetric];
  if (!cfg) return;

  document.getElementById("timeline-location").textContent =
    `${lat.toFixed(3)}° N, ${Math.abs(lng).toFixed(3)}° W`;
  document.getElementById("timeline-meta").textContent =
    `${cfg.label} · ${metadata.scenarios[activeScenario]?.label || activeScenario}`;

  buildTimelineChart(cfg);
}

function buildTimelineChart(cfg) {
  const canvas = document.getElementById("timeline-chart");
  if (timelineChart) { timelineChart.destroy(); timelineChart = null; }

  const allYears = [];
  for (let y = 1980; y <= 2100; y++) allYears.push(y);

  const datasets = [{
    label: cfg.chart_label,
    data: allYears.map(() => null),
    borderColor: "#3ecfcf",
    borderWidth: 1.5,
    pointRadius: 0,
    fill: false,
    tension: 0.3,
  }];

  if (cfg.viability_line != null) {
    datasets.push({
      label: "Viability threshold",
      data: allYears.map(() => cfg.viability_line),
      borderColor: "rgba(245,158,58,0.6)",
      borderWidth: 1,
      borderDash: [4, 4],
      pointRadius: 0,
      fill: false,
    });
  }

  timelineChart = new Chart(canvas, {
    type: "line",
    data: { labels: allYears, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: { legend: { display: false } },
      scales: {
        x: {
          display: true,
          ticks: { color: "#4d7a96", font: { size: 9 }, maxTicksLimit: 7, maxRotation: 0 },
          grid:  { color: "rgba(255,255,255,0.03)" },
        },
        y: {
          display: true,
          ticks: { color: "#4d7a96", font: { size: 9 }, maxTicksLimit: 5 },
          grid:  { color: "rgba(255,255,255,0.04)" },
        },
      },
    },
  });
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
    document.getElementById("timeline-panel").classList.add("hidden");
    if (activeMarker) activeMarker.remove();
    activeMarker = null;
    clickedPoint = null;
  }
});

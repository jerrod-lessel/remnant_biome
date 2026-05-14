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

// Reveal circle — radius in miles, feather = fraction of radius that fades
const REVEAL_RADIUS_MILES = 15;
const REVEAL_FEATHER       = 0.20; // outer 20% of circle fades to transparent

// Fixed zoom level on click (no accumulation)
const REVEAL_ZOOM = 8;

// Canvas resolution for compositing
const CANVAS_SIZE = 1024;

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
        "fill-outline-color": "rgba(0,0,0,0)", // suppress graticule edge lines
      },
    });

    console.log("CA mask added from Esri FeatureServer");

  } catch (e) {
    console.warn("CA mask failed:", e);
  }
}

// ── CANVAS COMPOSITING ────────────────────────────────────────
//
// How it works:
//   1. Create a fresh blank canvas (guarantees transparent background)
//   2. Draw a radial gradient onto it — opaque center, transparent edge
//   3. Draw the PNG on top using "source-in" composite mode
//      source-in: result pixels = new draw (PNG), but only where the
//      existing canvas already has alpha — so PNG is clipped to the circle
//   4. Export as data URL → MapLibre renders geo-anchored to IMG_BOUNDS
//
// Fresh canvas per call avoids any bleed from previous composites.

// Convert a geographic coordinate to canvas pixel space
function geoToCanvas(lng, lat) {
  const [west, south, east, north] = IMG_BOUNDS;
  const x = ((lng - west)  / (east  - west))  * CANVAS_SIZE;
  const y = ((north - lat) / (north - south)) * CANVAS_SIZE; // y flipped
  return { x, y };
}

// Convert miles to canvas pixels using the north-south span of IMG_BOUNDS
function milesToCanvasPixels(miles) {
  const [, south, , north] = IMG_BOUNDS;
  const degSpan   = north - south;
  const milesSpan = degSpan * 69.0;
  return (miles / milesSpan) * CANVAS_SIZE;
}

// Composite the PNG with a radial reveal mask — returns a data URL
async function compositeReveal(pngUrl, lng, lat) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // No crossOrigin needed — PNGs are same-origin on Cloudflare Pages
    // Setting crossOrigin="anonymous" on a same-origin request can cause
    // the browser to taint the canvas and block toDataURL()

    img.onload = () => {
      // Fresh canvas every call — truly transparent background guaranteed
      const canvas  = document.createElement("canvas");
      canvas.width  = CANVAS_SIZE;
      canvas.height = CANVAS_SIZE;
      const ctx     = canvas.getContext("2d");

      // Step 1: draw radial gradient mask onto blank canvas
      // Opaque at center, transparent at edge — defines the alpha shape
      const { x, y } = geoToCanvas(lng, lat);
      const outerR    = milesToCanvasPixels(REVEAL_RADIUS_MILES);
      const innerR    = outerR * (1 - REVEAL_FEATHER);

      const grad = ctx.createRadialGradient(x, y, innerR, x, y, outerR);
      grad.addColorStop(0, "rgba(0,0,0,1)"); // opaque — PNG will show here
      grad.addColorStop(1, "rgba(0,0,0,0)"); // transparent — PNG erased here

      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

      // Step 2: draw PNG clipped to the gradient shape
      // source-in: new pixels only appear where existing canvas has alpha
      ctx.globalCompositeOperation = "source-in";
      ctx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE);

      // Debug: sample center pixel to verify PNG colors came through
      const { x: cx, y: cy } = geoToCanvas(lng, lat);
      const px = ctx.getImageData(Math.floor(cx), Math.floor(cy), 1, 1).data;
      console.log(`Center pixel RGBA: r=${px[0]} g=${px[1]} b=${px[2]} a=${px[3]}`);

      resolve(canvas.toDataURL("image/png"));
    };

    img.onerror = () => reject(new Error(`Failed to load PNG: ${pngUrl}`));
    img.src = pngUrl;
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

// Update the raster layer — composites reveal if click point exists
async function updateMapLayer() {
  const scenario = getScenarioForYear(activeYear, activeScenario);
  if (!scenario) return;

  const sourceId = "climate-raster";
  const layerId  = "climate-raster-layer";

  // No click point — keep layer hidden
  if (!clickedPoint) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", "none");
    }
    return;
  }

  const pngUrl = getPngUrl(activeMetric, scenario, activeYear);

  try {
    const dataUrl = await compositeReveal(pngUrl, clickedPoint.lng, clickedPoint.lat);

    if (map.getLayer(layerId)) {
      map.getSource(sourceId).updateImage({
        url: dataUrl,
        coordinates: boundsToCoords(IMG_BOUNDS),
      });
      map.setLayoutProperty(layerId, "visibility", "visible");
    } else {
      map.addSource(sourceId, {
        type: "image",
        url: dataUrl,
        coordinates: boundsToCoords(IMG_BOUNDS),
      });
      map.addLayer(
        {
          id: layerId,
          type: "raster",
          source: sourceId,
          paint: {
            "raster-opacity": 1.0,
            "raster-resampling": "nearest",
          },
        },
        map.getLayer("ca-mask-layer") ? "ca-mask-layer" : undefined
      );
    }
  } catch (err) {
    console.error("Reveal composite failed:", err);
  }
}

function hideRasterLayer() {
  if (map.getLayer("climate-raster-layer")) {
    map.setLayoutProperty("climate-raster-layer", "visibility", "none");
  }
}

// ── MAP READY ─────────────────────────────────────────────────

map.on("load", async () => {
  const ok = await loadMetadata();
  if (!ok) return;
  await addCaliforniaMask();
  // No raster on load — nothing shows until first click
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

// ── DISMISS ───────────────────────────────────────────────────

function dismiss() {
  document.getElementById("timeline-panel").classList.add("hidden");
  document.getElementById("click-hint").classList.remove("hidden");
  if (activeMarker) activeMarker.remove();
  activeMarker = null;
  clickedPoint = null;
  hideRasterLayer();
  map.flyTo({ center: [-119.5, 37.5], zoom: 5.5, duration: 800 });
}

// ── MAP CLICK ─────────────────────────────────────────────────

map.on("click", async e => {
  const lat = e.lngLat.lat;
  const lng = e.lngLat.lng;

  if (lat < CA_BOUNDS.minLat || lat > CA_BOUNDS.maxLat ||
      lng < CA_BOUNDS.minLng || lng > CA_BOUNDS.maxLng) return;

  clickedPoint = { lat, lng };

  map.easeTo({
    center: [lng, lat],
    zoom: REVEAL_ZOOM,
    duration: 600,
  });

  await updateMapLayer();

  placeMarker(e.lngLat);
  document.getElementById("click-hint").classList.add("hidden");
  document.getElementById("timeline-panel").classList.remove("hidden");
  await updateTimeline(lat, lng);
});

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
    dismiss();
  }
});

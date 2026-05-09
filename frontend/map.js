/* ============================================================
   Remnant Biome — map.js
   MapLibre GL JS frontend for climate envelope visualization.

   Architecture:
   - PNG stack served from /pngs/ (pre-rendered, one per metric/year/scenario)
   - metadata.json drives all thresholds, labels, year ranges
   - Ensemble Zarr stores queried on click for timeline chart (p10/p90 band)
   - No backend — fully static on Cloudflare Pages
============================================================ */

// ── CONFIG ────────────────────────────────────────────────────

// Base URL for PNG stack and metadata
// In production this will be the Cloudflare Pages URL
const PNG_BASE = window.location.hostname === "localhost"
  ? ""
  : "";

// California bounds for click filtering
const CA_BOUNDS = {
  minLat: 32.5, maxLat: 42.1,
  minLng: -124.5, maxLng: -114.1,
};

// Animation speed (ms per year)
const PLAY_INTERVAL_MS = 120;

// ── STATE ─────────────────────────────────────────────────────

let metadata      = null;
let activeMetric  = "almonds_chill_hours";
let activeScenario = "ssp245";
let activeYear    = 2045;
let isPlaying     = false;
let playTimer     = null;
let activeMarker  = null;
let timelineChart = null;
let clickedPoint  = null;

// ── MAP INIT ──────────────────────────────────────────────────

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      "carto-dark": {
        type: "raster",
        tiles: ["https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"],
        tileSize: 256,
        attribution: "© Carto © OpenStreetMap contributors",
        maxzoom: 19,
      },
    },
    layers: [{
      id: "carto-dark-layer",
      type: "raster",
      source: "carto-dark",
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
    console.log("Metadata loaded:", Object.keys(metadata.metrics).length, "metrics");
    return true;
  } catch (err) {
    console.error("Failed to load metadata.json:", err);
    return false;
  }
}

// ── PNG LAYER MANAGEMENT ──────────────────────────────────────

function getPngUrl(metric, scenario, year) {
  return `${PNG_BASE}/pngs/${metric}/${scenario}_${year}.png`;
}

function getScenarioForYear(year, selectedScenario) {
  // Historical scenario only has years 1980-2014
  // Future scenarios only have years 2015-2100
  if (selectedScenario === "historical") {
    return year <= 2014 ? "historical" : null;
  }
  if (year <= 2014) return "historical";
  return selectedScenario;
}

function updateMapLayer() {
  const scenario = getScenarioForYear(activeYear, activeScenario);
  if (!scenario) return;

  const url = getPngUrl(activeMetric, scenario, activeYear);
  const sourceId = "climate-raster";
  const layerId  = "climate-raster-layer";

  // CA bounding box in the data
  const bounds = [-128.422, 29.578, -110.984, 45.016];

  if (map.getLayer(layerId)) {
    // Update existing source
    const source = map.getSource(sourceId);
    if (source) {
      source.updateImage({ url, coordinates: boundsToCoords(bounds) });
    }
  } else {
    // Add source and layer for first time
    map.addSource(sourceId, {
      type: "image",
      url,
      coordinates: boundsToCoords(bounds),
    });

    map.addLayer({
      id: layerId,
      type: "raster",
      source: sourceId,
      paint: {
        "raster-opacity": 0.85,
        "raster-resampling": "nearest",
      },
    });
  }
}

function boundsToCoords(bounds) {
  // [west, south, east, north] → MapLibre image coordinates
  // [[nw], [ne], [se], [sw]]
  const [west, south, east, north] = bounds;
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
}

// ── MAP READY ─────────────────────────────────────────────────

map.on("load", async () => {
  const ok = await loadMetadata();
  if (!ok) return;

  updateMapLayer();
  updateYearDisplay();
  checkDeficitBadge();
});

// ── ZOOM + HOME CONTROLS ──────────────────────────────────────

document.getElementById("zoom-in").addEventListener("click", () => {
  map.zoomIn();
});

document.getElementById("zoom-out").addEventListener("click", () => {
  map.zoomOut();
});

document.getElementById("home-btn").addEventListener("click", () => {
  map.flyTo({ center: [-119.5, 37.5], zoom: 5.5, duration: 800 });
});

// ── PILL SELECTORS ────────────────────────────────────────────

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

// ── SCENARIO SELECTOR ─────────────────────────────────────────

document.querySelectorAll(".scenario-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".scenario-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeScenario = btn.dataset.scenario;

    // Clamp year to valid range for this scenario
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
  if (activeScenario === "historical") {
    slider.min = 1980;
    slider.max = 2014;
  } else {
    slider.min = 1980;
    slider.max = 2100;
  }
}

// ── YEAR SLIDER ───────────────────────────────────────────────

document.getElementById("year-slider").addEventListener("input", e => {
  activeYear = parseInt(e.target.value);
  updateYearDisplay();
  updateMapLayer();
  updateTimelineMarker();
});

function updateYearDisplay() {
  document.getElementById("year-label").textContent = activeYear;
}

// ── PLAY / ANIMATE ────────────────────────────────────────────

const playBtn = document.getElementById("play-btn");

playBtn.addEventListener("click", () => {
  isPlaying ? stopPlay() : startPlay();
});

function startPlay() {
  isPlaying = true;
  playBtn.innerHTML = "&#9646;&#9646;"; // pause icon
  playBtn.classList.add("playing");

  const minYear = activeScenario === "historical" ? 1980 : 1980;
  const maxYear = activeScenario === "historical" ? 2014 : 2100;

  if (activeYear >= maxYear) {
    activeYear = minYear;
    document.getElementById("year-slider").value = minYear;
  }

  playTimer = setInterval(() => {
    activeYear++;
    if (activeYear > maxYear) {
      stopPlay();
      return;
    }
    document.getElementById("year-slider").value = activeYear;
    updateYearDisplay();
    updateMapLayer();
    updateTimelineMarker();
  }, PLAY_INTERVAL_MS);
}

function stopPlay() {
  isPlaying = false;
  playBtn.innerHTML = "&#9654;"; // play icon
  playBtn.classList.remove("playing");
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
  }
}

// ── CLICK MARKER ──────────────────────────────────────────────

function placeMarker(lngLat) {
  if (activeMarker) activeMarker.remove();

  const el = document.createElement("div");
  el.className = "click-marker";

  activeMarker = new maplibregl.Marker({ element: el })
    .setLngLat(lngLat)
    .addTo(map);
}

// ── MAP CLICK ─────────────────────────────────────────────────

map.on("click", async e => {
  const { lat, lng } = e.latlng || { lat: e.lngLat.lat, lng: e.lngLat.lng };
  const lat2 = e.lngLat.lat;
  const lng2 = e.lngLat.lng;

  // Filter to California
  if (
    lat2 < CA_BOUNDS.minLat || lat2 > CA_BOUNDS.maxLat ||
    lng2 < CA_BOUNDS.minLng || lng2 > CA_BOUNDS.maxLng
  ) return;

  placeMarker(e.lngLat);
  clickedPoint = { lat: lat2, lng: lng2 };

  document.getElementById("click-hint").classList.add("hidden");
  document.getElementById("timeline-panel").classList.remove("hidden");

  await updateTimeline(lat2, lng2);
});

// ── TIMELINE PANEL ────────────────────────────────────────────

document.getElementById("timeline-close").addEventListener("click", () => {
  document.getElementById("timeline-panel").classList.add("hidden");
  if (activeMarker) activeMarker.remove();
  activeMarker  = null;
  clickedPoint  = null;
});

async function updateTimeline(lat, lng) {
  if (!metadata) return;

  const cfg = metadata.metrics[activeMetric];
  if (!cfg) return;

  // Update header
  document.getElementById("timeline-location").textContent =
    `${lat.toFixed(3)}° N, ${Math.abs(lng).toFixed(3)}° W`;
  document.getElementById("timeline-meta").textContent =
    `${cfg.label} · ${metadata.scenarios[activeScenario]?.label || activeScenario}`;

  // Load Zarr data for this point via the ensemble zarr files
  // For now we build a synthetic chart from available PNG metadata
  // Full Zarr-on-click will be wired in next iteration
  buildTimelineChart(lat, lng, cfg);
}

function buildTimelineChart(lat, lng, cfg) {
  const canvas = document.getElementById("timeline-chart");
  const ctx    = canvas.getContext("2d");

  if (timelineChart) {
    timelineChart.destroy();
    timelineChart = null;
  }

  // Build year axis
  const allYears = [];
  for (let y = 1980; y <= 2100; y++) allYears.push(y);

  // Viability threshold line value
  const thresholdVal = cfg.viability_line ?? cfg.viability_line_low ?? null;

  // Placeholder datasets — will be replaced with real Zarr values
  // when the click-point data loading is wired up
  const placeholderData = allYears.map(y => null);

  const datasets = [
    {
      label: cfg.chart_label,
      data: placeholderData,
      borderColor: "#3ecfcf",
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
      tension: 0.3,
    },
  ];

  // Add viability threshold line if defined
  if (thresholdVal !== null) {
    datasets.push({
      label: "Viability threshold",
      data: allYears.map(() => thresholdVal),
      borderColor: "rgba(245,158,58,0.6)",
      borderWidth: 1,
      borderDash: [4, 4],
      pointRadius: 0,
      fill: false,
    });
  }

  timelineChart = new Chart(ctx, {
    type: "line",
    data: { labels: allYears, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          backgroundColor: "rgba(15,30,43,0.95)",
          borderColor: "rgba(255,255,255,0.1)",
          borderWidth: 0.5,
          titleColor: "#7a9ab0",
          bodyColor: "#3ecfcf",
          titleFont: { size: 10 },
          bodyFont: { size: 11, family: "monospace" },
          callbacks: {
            title: items => `${items[0].label}`,
            label: item => `  ${item.parsed.y !== null ? item.parsed.y.toFixed(1) : "no data"} ${cfg.units}`,
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
          ticks: { color: "#4d7a96", font: { size: 9 }, maxTicksLimit: 5 },
          grid:  { color: "rgba(255,255,255,0.04)" },
        },
      },
    },
  });

  // Draw current year indicator
  updateTimelineMarker();
}

function updateTimelineMarker() {
  // Highlight the current year on the chart via a vertical annotation
  // This will be wired up when we add the chartjs-plugin-annotation
  // For now just a visual note in the year display
}

// ── DEFICIT BADGE ─────────────────────────────────────────────

function checkDeficitBadge() {
  if (!metadata) return;
  const cfg = metadata.metrics[activeMetric];
  if (!cfg) return;

  // Show badge for metrics where deficit is meaningful
  // This will be wired to actual data values in the full implementation
  const badge = document.getElementById("deficit-badge");
  badge.classList.add("hidden");
}

// ── ABOUT TOGGLE ──────────────────────────────────────────────

document.getElementById("about-toggle").addEventListener("click", () => {
  document.getElementById("about-panel").classList.toggle("hidden");
});

// ── KEYBOARD SHORTCUTS ────────────────────────────────────────

document.addEventListener("keydown", e => {
  if (e.key === "ArrowRight" || e.key === "ArrowUp") {
    if (activeYear < 2100) {
      activeYear++;
      document.getElementById("year-slider").value = activeYear;
      updateYearDisplay();
      updateMapLayer();
      updateTimelineMarker();
    }
  } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
    if (activeYear > 1980) {
      activeYear--;
      document.getElementById("year-slider").value = activeYear;
      updateYearDisplay();
      updateMapLayer();
      updateTimelineMarker();
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

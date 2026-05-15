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
const REVEAL_FEATHER       = 0.20;

// Fixed zoom level on click
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

// ── CANVAS COMPOSITING ────────────────────────────────────────
//
// Two coordinate systems must stay consistent:
//
// 1. geoToCanvas — places the radial gradient on the canvas
//    Canvas 2D: y=0 is TOP (north), y=CANVAS_SIZE is BOTTOM (south)
//    So: y = (north - lat) / (north - south) * CANVAS_SIZE
//
// 2. lngLatToUV — maps quad corners to texture sample points
//    WebGL texImage2D uploads canvas rows top-to-bottom
//    WebGL samples: v=0 is BOTTOM of texture, v=1 is TOP
//    Canvas top (north) → uploaded as row 0 → sampled at v=1
//    Canvas bottom (south) → uploaded as last row → sampled at v=0
//    So: v = (lat - south) / (north - south)   ← OPPOSITE of geoToCanvas Y
//
// These must be opposites. That's not a hack — it's the correct
// relationship between canvas 2D (top-origin) and WebGL UV (bottom-origin).

const [west, south, east, north] = IMG_BOUNDS;

// Canvas 2D: place gradient center — north=y0, south=y=CANVAS_SIZE
function geoToCanvas(lng, lat) {
  const x = ((lng  - west)  / (east  - west))  * CANVAS_SIZE;
  const y = ((north - lat)  / (north - south)) * CANVAS_SIZE; // top-origin
  return { x, y };
}

// Miles to canvas pixels using the Y span of IMG_BOUNDS
function milesToCanvasPixels(miles) {
  const milesSpan = (north - south) * 69.0;
  return (miles / milesSpan) * CANVAS_SIZE;
}

// WebGL UV: v=0 at south (canvas bottom), v=1 at north (canvas top)
// This is OPPOSITE to geoToCanvas Y — correct by WebGL convention
function lngLatToUV(lng, lat) {
  const u = (lng  - west)  / (east  - west);
  const v = (lat  - south) / (north - south); // bottom-origin, opposite of canvas
  return [u, v];
}

// Shared offscreen canvas
const revealCanvas  = document.createElement("canvas");
revealCanvas.width  = CANVAS_SIZE;
revealCanvas.height = CANVAS_SIZE;
const revealCtx     = revealCanvas.getContext("2d");

let revealReady = false;

async function compositeReveal(pngUrl, lng, lat) {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      // Clear canvas
      revealCtx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

      // Step 1: draw full PNG — top of image = north, bottom = south
      revealCtx.globalCompositeOperation = "source-over";
      revealCtx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE);

      // Step 2: radial gradient centered on click point in canvas coords
      // geoToCanvas uses top-origin (north=y0) matching drawImage orientation
      const { x, y } = geoToCanvas(lng, lat);
      const outerR    = milesToCanvasPixels(REVEAL_RADIUS_MILES);
      const innerR    = outerR * (1 - REVEAL_FEATHER);

      const grad = revealCtx.createRadialGradient(x, y, innerR, x, y, outerR);
      grad.addColorStop(0, "rgba(0,0,0,1)"); // opaque center — PNG kept
      grad.addColorStop(1, "rgba(0,0,0,0)"); // transparent edge — PNG erased

      // Step 3: destination-in erases PNG pixels outside the gradient circle
      revealCtx.globalCompositeOperation = "destination-in";
      revealCtx.fillStyle = grad;
      revealCtx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

      revealCtx.globalCompositeOperation = "source-over";
      resolve(revealCanvas);
    };

    img.onerror = (e) => reject(new Error(`PNG load failed: ${pngUrl}`));
    img.src = pngUrl;
  });
}

// ── WEBGL CUSTOM LAYER ────────────────────────────────────────
//
// Renders the composited canvas as a geo-anchored texture using MapLibre's
// custom layer API. Vertex positions are in Mercator [0,1] space so
// MapLibre's u_matrix maps them correctly to screen. UV coords use the
// bottom-origin WebGL convention (v=0 south, v=1 north).

function lngLatToMercator(lng, lat) {
  const x = (lng + 180) / 360;
  const y = (1 - Math.log(
    Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)
  ) / Math.PI) / 2;
  return [x, y];
}

// Quad corners — Mercator positions for geo-anchoring
const bl = lngLatToMercator(west,  south);
const br = lngLatToMercator(east,  south);
const tr = lngLatToMercator(east,  north);
const tl = lngLatToMercator(west,  north);

// UV corners — bottom-origin WebGL convention
const uvBL = lngLatToUV(west,  south); // [0, 0] — south=v0
const uvBR = lngLatToUV(east,  south); // [1, 0]
const uvTR = lngLatToUV(east,  north); // [1, 1] — north=v1
const uvTL = lngLatToUV(west,  north); // [0, 1]

const quadVertices = new Float32Array([
  //  mercX     mercY      u         v
  bl[0], bl[1],  uvBL[0], uvBL[1],  // SW corner
  br[0], br[1],  uvBR[0], uvBR[1],  // SE corner
  tr[0], tr[1],  uvTR[0], uvTR[1],  // NE corner
  bl[0], bl[1],  uvBL[0], uvBL[1],  // SW corner
  tr[0], tr[1],  uvTR[0], uvTR[1],  // NE corner
  tl[0], tl[1],  uvTL[0], uvTL[1],  // NW corner
]);

const revealLayer = {
  id:            "reveal-layer",
  type:          "custom",
  renderingMode: "2d",

  onAdd(map, gl) {
    const vsSource = `
      uniform mat4 u_matrix;
      attribute vec2 a_pos;
      attribute vec2 a_uv;
      varying vec2 v_uv;
      void main() {
        gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
        v_uv = a_uv;
      }
    `;

    const fsSource = `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_uv;
      void main() {
        gl_FragColor = texture2D(u_texture, v_uv);
      }
    `;

    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS))
      console.error("VS error:", gl.getShaderInfoLog(vs));

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSource);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS))
      console.error("FS error:", gl.getShaderInfoLog(fs));

    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
      console.error("Link error:", gl.getProgramInfoLog(this.program));

    this.a_pos     = gl.getAttribLocation(this.program,  "a_pos");
    this.a_uv      = gl.getAttribLocation(this.program,  "a_uv");
    this.u_matrix  = gl.getUniformLocation(this.program, "u_matrix");
    this.u_texture = gl.getUniformLocation(this.program, "u_texture");

    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  },

  render(gl, matrix) {
    if (!revealReady) return;

    gl.useProgram(this.program);

    // Upload canvas as texture each frame
    // texImage2D reads canvas rows top-to-bottom → row 0 = canvas top = north
    // WebGL samples row 0 at v=1, last row at v=0 — hence lngLatToUV uses (lat-south)
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, revealCanvas);

    const stride = 4 * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(this.a_pos);
    gl.vertexAttribPointer(this.a_pos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.a_uv);
    gl.vertexAttribPointer(this.a_uv, 2, gl.FLOAT, false, stride, 2 * 4);

    gl.uniformMatrix4fv(this.u_matrix, false, matrix);
    gl.uniform1i(this.u_texture, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  },
};

// ── PNG + REVEAL UPDATE ───────────────────────────────────────

function getPngUrl(metric, scenario, year) {
  return `${PNG_BASE}/pngs/${metric}/${scenario}_${year}.png`;
}

function getScenarioForYear(year, selectedScenario) {
  if (selectedScenario === "historical") return year <= 2014 ? "historical" : null;
  if (year <= 2014) return "historical";
  return selectedScenario;
}

async function updateMapLayer() {
  const scenario = getScenarioForYear(activeYear, activeScenario);
  if (!scenario) return;

  if (!clickedPoint) {
    revealReady = false;
    map.triggerRepaint();
    return;
  }

  const pngUrl = getPngUrl(activeMetric, scenario, activeYear);

  try {
    await compositeReveal(pngUrl, clickedPoint.lng, clickedPoint.lat);
    revealReady = true;
    map.triggerRepaint();
  } catch (err) {
    console.error("Reveal composite failed:", err);
  }
}

// ── MAP READY ─────────────────────────────────────────────────

map.on("load", async () => {
  const ok = await loadMetadata();
  if (!ok) return;
  await addCaliforniaMask();
  map.addLayer(revealLayer, "ca-mask-layer");
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
  revealReady  = false;
  map.triggerRepaint();
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

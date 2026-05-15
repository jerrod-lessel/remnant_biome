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

    console.log("CA mask added from Esri FeatureServer");
  } catch (e) {
    console.warn("CA mask failed:", e);
  }
}

// ── CANVAS COMPOSITING ────────────────────────────────────────
//
// Composites the PNG with a radial reveal mask onto an offscreen canvas.
// Returns the canvas element itself (not a data URL) so the WebGL layer
// can upload it directly as a texture with proper alpha.

function geoToCanvas(lng, lat) {
  const [west, south, east, north] = IMG_BOUNDS;
  // X: linear, west=0, east=CANVAS_SIZE
  const x = ((lng  - west)  / (east  - west))  * CANVAS_SIZE;
  // Y: linear, north=0 (canvas top), south=CANVAS_SIZE (canvas bottom)
  const y = ((north - lat)  / (north - south)) * CANVAS_SIZE;
  return { x, y };
}

function milesToCanvasPixels(miles) {
  // PNG pixels are linearly spaced in lat/lng — same as geoToCanvas
  // 1 degree latitude ≈ 69 miles; canvas spans (north - south) degrees
  const [, south, , north] = IMG_BOUNDS;
  const degSpan   = north - south;
  const milesSpan = degSpan * 69.0;
  return (miles / milesSpan) * CANVAS_SIZE;
}

// Shared offscreen canvas — reused across frames for performance
const revealCanvas  = document.createElement("canvas");
revealCanvas.width  = CANVAS_SIZE;
revealCanvas.height = CANVAS_SIZE;
const revealCtx     = revealCanvas.getContext("2d");

// Tracks whether the canvas has valid content to render
let revealReady = false;

async function compositeReveal(pngUrl, lng, lat) {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      revealCtx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

      // Step 1: draw full PNG onto canvas
      revealCtx.globalCompositeOperation = "source-over";
      revealCtx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE);

      // Step 2: build radial gradient — opaque center, transparent edge
      const { x, y } = geoToCanvas(lng, lat);
      const outerR    = milesToCanvasPixels(REVEAL_RADIUS_MILES);
      const innerR    = outerR * (1 - REVEAL_FEATHER);

      const grad = revealCtx.createRadialGradient(x, y, innerR, x, y, outerR);
      grad.addColorStop(0, "rgba(0,0,0,1)");
      grad.addColorStop(1, "rgba(0,0,0,0)");

      // Step 3: destination-in — keeps PNG pixels only where gradient is opaque
      // This correctly erases PNG pixels outside the circle to true transparency
      revealCtx.globalCompositeOperation = "destination-in";
      revealCtx.fillStyle = grad;
      revealCtx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

      revealCtx.globalCompositeOperation = "source-over";
      resolve(revealCanvas);
    };

    img.onerror = (e) => { console.error(`PNG load failed: ${pngUrl}`, e); reject(new Error(`PNG load failed: ${pngUrl}`)); };
    console.log(`Compositing PNG: ${pngUrl} at canvas (${Math.round(0)},${Math.round(0)})`);
    img.src = pngUrl;
  });
}

// ── WEBGL CUSTOM LAYER ────────────────────────────────────────
//
// A MapLibre custom layer renders directly into the map's WebGL context.
// This gives us full control over blending — so transparent canvas pixels
// stay transparent instead of becoming black (the MapLibre image source bug).
//
// How it works:
//   - onAdd: compile shaders, create GPU buffers for a rectangle quad
//             mapped to IMG_BOUNDS in Mercator coordinates
//   - render: upload canvas as texture each frame, draw quad with alpha blend
//   - map.triggerRepaint(): tells MapLibre to call render() again
//
// The vertex shader transforms Mercator coords to clip space using the
// map's projection matrix (u_matrix), which MapLibre provides automatically.
// This means the quad pans, zooms, and rotates perfectly with the map.

// Convert lng/lat to Mercator (0–1 range that MapLibre uses internally)
// Used only for quad vertex positions — MapLibre's matrix expects Mercator
function lngLatToMercator(lng, lat) {
  const x = (lng + 180) / 360;
  const y = (1 - Math.log(
    Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)
  ) / Math.PI) / 2;
  return [x, y];
}

// Quad vertex POSITIONS are in Mercator (for correct geo-anchoring in MapLibre)
// Quad vertex UVs map to the PNG canvas which is linearly spaced in lat/lng
// The PNG is NOT Mercator — it's a plain geographic raster
const [west, south, east, north] = IMG_BOUNDS;
const bl = lngLatToMercator(west,  south);
const br = lngLatToMercator(east,  south);
const tr = lngLatToMercator(east,  north);
const tl = lngLatToMercator(west,  north);

// UV coords: map each corner's lat/lng linearly onto canvas [0,1] space
// This matches how geoToCanvas() works — pure linear lat/lng mapping
function lngLatToUV(lng, lat) {
  const u = (lng  - west)  / (east  - west);
  // WebGL v=0 is at bottom of texture, v=1 at top
  // lat=south → v=0 (texture bottom), lat=north → v=1 (texture top)
  const v = (lat  - south) / (north - south);
  return [u, v];
}
const uvBL = lngLatToUV(west,  south);
const uvBR = lngLatToUV(east,  south);
const uvTR = lngLatToUV(east,  north);
const uvTL = lngLatToUV(west,  north);

// Two triangles forming a rectangle, with UV coords (texture coordinates)
// Positions (Mercator x,y) and UVs (0–1 texture space) interleaved
// Triangle 1: bl, br, tr — Triangle 2: bl, tr, tl
const quadVertices = new Float32Array([
  //  mercX     mercY      u         v
  bl[0], bl[1],  uvBL[0], uvBL[1],  // bottom-left
  br[0], br[1],  uvBR[0], uvBR[1],  // bottom-right
  tr[0], tr[1],  uvTR[0], uvTR[1],  // top-right
  bl[0], bl[1],  uvBL[0], uvBL[1],  // bottom-left
  tr[0], tr[1],  uvTR[0], uvTR[1],  // top-right
  tl[0], tl[1],  uvTL[0], uvTL[1],  // top-left
]);

const revealLayer = {
  id:             "reveal-layer",
  type:           "custom",
  renderingMode:  "2d",

  // ── onAdd: runs once when layer is added to the map ──────────
  onAdd(map, gl) {
    // Vertex shader — transforms Mercator position to screen clip space
    const vsSource = `
      uniform mat4 u_matrix;
      attribute vec2 a_pos;
      attribute vec2 a_uv;
      varying vec2 v_uv;
      void main() {
          // u_matrix from MapLibre's custom layer maps mercator [0,1] coords
        // directly to clip space — no need to multiply by tile extent
        gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
        v_uv = a_uv;
      }
    `;

    // Fragment shader — samples the canvas texture with alpha blending
    const fsSource = `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_uv;
      void main() {
        gl_FragColor = texture2D(u_texture, v_uv);
      }
    `;

    // Compile shaders
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error("Vertex shader error:", gl.getShaderInfoLog(vs));
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSource);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error("Fragment shader error:", gl.getShaderInfoLog(fs));
    }

    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      console.error("Shader link error:", gl.getProgramInfoLog(this.program));
    }

    // Get attribute and uniform locations
    this.a_pos     = gl.getAttribLocation(this.program,  "a_pos");
    this.a_uv      = gl.getAttribLocation(this.program,  "a_uv");
    this.u_matrix  = gl.getUniformLocation(this.program, "u_matrix");
    this.u_texture = gl.getUniformLocation(this.program, "u_texture");

    // Upload quad geometry to GPU
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);

    // Create texture slot (will be filled each frame from revealCanvas)
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  },

  // ── render: called by MapLibre every frame ────────────────────
  render(gl, matrix) {
    if (!revealReady) return; // nothing to draw yet

    gl.useProgram(this.program);

    // Upload canvas as texture — does this every frame so updates appear
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA,
      gl.UNSIGNED_BYTE, revealCanvas
    );

    // Bind vertex buffer and set up attribute pointers
    // Each vertex: [mercX(4), mercY(4), u(4), v(4)] = 16 bytes stride
    const stride = 4 * 4; // 4 floats × 4 bytes
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(this.a_pos);
    gl.vertexAttribPointer(this.a_pos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.a_uv);
    gl.vertexAttribPointer(this.a_uv, 2, gl.FLOAT, false, stride, 2 * 4);

    // Set uniforms
    gl.uniformMatrix4fv(this.u_matrix, false, matrix);
    gl.uniform1i(this.u_texture, 0);

    // Enable alpha blending — this is what makes transparency work
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied alpha

    // Draw the two triangles (6 vertices)
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

  console.log(`updateMapLayer: pngUrl=${pngUrl} clickedPoint=${JSON.stringify(clickedPoint)}`);
  try {
    await compositeReveal(pngUrl, clickedPoint.lng, clickedPoint.lat);
    revealReady = true;
    console.log(`revealReady set true, triggering repaint`);
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

  // Add the custom WebGL layer above the CA mask
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
  activeMarker  = null;
  clickedPoint  = null;
  revealReady   = false;
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

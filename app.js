/* ===============================
   Safe Route App (Leaflet + ORS)
   Noor GIS Project
   =============================== */

// IMPORTANT:
// - ORS_API_KEY must be defined ONLY in config.js (not here)
//   Example: const ORS_API_KEY = "xxxx";

let map;
let baseLayer;

let zonesLayer, roadsLayer, floodLayer;
let floodDataGlobal = null;

let startMarker = null;
let endMarker = null;
let routeLayer = null;

let startLatLng = null;
let endLatLng = null;

// ---------- Helpers ----------
function $(id) {
  return document.getElementById(id);
}

function showStatus(msg) {
  const el = $("statusBox");
  if (el) el.textContent = msg;
}

function clearRoute() {
  if (routeLayer) {
    map.removeLayer(routeLayer);
    routeLayer = null;
  }
}

function resetAll() {
  if (startMarker) map.removeLayer(startMarker);
  if (endMarker) map.removeLayer(endMarker);
  startMarker = null;
  endMarker = null;
  startLatLng = null;
  endLatLng = null;
  clearRoute();
  showStatus("اختاري نقطة البداية ثم نقطة النهاية على الخريطة.");
}

// ---------- Flood styling ----------
function getFloodColor(gridcode) {
  const v = Number(gridcode);
  if (v === 1) return "#2ca25f"; // منخفضة جدًا
  if (v === 2) return "#66c2a4"; // منخفضة
  if (v === 3) return "#fee08b"; // متوسطة
  if (v === 4) return "#f46d43"; // عالية
  return "#d73027";              // عالية جدًا (5)
}

function floodStyle(feature) {
  const g = feature?.properties?.gridcode;
  return {
    color: "#2b2b2b",
    weight: 0.4,
    fillColor: getFloodColor(g),
    fillOpacity: 0.65
  };
}

function zonesStyle() {
  return { color: "#ffffff", weight: 1.2, fillOpacity: 0 };
}

function roadsStyle() {
  return { color: "#ffffff", weight: 2, opacity: 0.7 };
}

// ---------- ORS helpers ----------

// ORS expects avoid_polygons as a GEOMETRY (Polygon/MultiPolygon), not FeatureCollection.
// We'll convert high-risk flood features (gridcode >=4) into one MultiPolygon geometry.
function buildAvoidPolygonsGeometry(floodFC) {
  if (!floodFC?.features?.length) return null;

  const highs = floodFC.features.filter(f => Number(f?.properties?.gridcode) >= 4);
  if (!highs.length) return null;

  const multiCoords = [];

  for (const f of highs) {
    const geom = f?.geometry;
    if (!geom) continue;

    if (geom.type === "Polygon") {
      // Polygon.coordinates = [ [ring1], [ring2]... ]
      multiCoords.push(geom.coordinates);
    } else if (geom.type === "MultiPolygon") {
      // MultiPolygon.coordinates = [ [ [ring]... ], [ [ring]... ] ... ]
      for (const poly of geom.coordinates) multiCoords.push(poly);
    }
  }

  if (!multiCoords.length) return null;

  return { type: "MultiPolygon", coordinates: multiCoords };
}

async function fetchORSRoute(start, end, avoidGeometry = null) {
  const url = "https://api.openrouteservice.org/v2/directions/driving-car/geojson";

  // radiuses: increase snap radius to reduce "could not find routable point within 350m"
  const body = {
    coordinates: [
      [start.lng, start.lat],
      [end.lng, end.lat]
    ],
    radiuses: [2000, 2000] // meters (زيديها لو لسه بطلع 404)
  };

  if (avoidGeometry) {
    body.options = { avoid_polygons: avoidGeometry };
  }

  // Validate key exists
  if (typeof ORS_API_KEY === "undefined" || !ORS_API_KEY) {
    throw new Error("ORS_API_KEY is missing. Put it in config.js فقط.");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: ORS_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`ORS Error ${res.status}: ${t}`);
  }

  return await res.json();
}

function drawRoute(routeGeojson, isSafe = true) {
  clearRoute();

  routeLayer = L.geoJSON(routeGeojson, {
    style: {
      color: isSafe ? "#00ffd5" : "#ffcc00",
      weight: 5,
      opacity: 0.9
    }
  }).addTo(map);

  map.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });
}

async function calculateSafeRoute() {
  if (!startLatLng || !endLatLng) {
    alert("لازم تختار نقطتين: البداية والنهاية.");
    return;
  }

  if (!floodDataGlobal) {
    alert("طبقة الخطورة (flood) لم تُحمّل بعد. استني ثواني وجربي.");
    return;
  }

  showStatus("جاري حساب المسار الآمن...");

  const avoidGeom = buildAvoidPolygonsGeometry(floodDataGlobal);

  try {
    // 1) Safe route (avoid high risk)
    const safeRoute = await fetchORSRoute(startLatLng, endLatLng, avoidGeom);
    drawRoute(safeRoute, true);
    showStatus("✅ تم إيجاد مسار آمن يتجنب مناطق الخطورة العالية قدر الإمكان.");
  } catch (e) {
    console.warn("Safe route failed:", e);

    try {
      // 2) Fallback: normal route
      const normalRoute = await fetchORSRoute(startLatLng, endLatLng, null);
      drawRoute(normalRoute, false);
      showStatus("⚠️ تعذّر تجنب مناطق الخطر بالكامل. تم عرض أفضل مسار متاح.");
    } catch (e2) {
      console.error("Normal route failed:", e2);
      showStatus("❌ فشل حساب المسار. تأكدي من المفتاح/الإنترنت/اختيار نقاط قرب الطرق.");
      alert("فشل حساب المسار. افتحي Console (F12) وشوفي الخطأ.");
    }
  }
}

// ---------- UI controls ----------


function addLegend() {
  const legend = L.control({ position: "bottomright" });

  legend.onAdd = function () {
    const div = L.DomUtil.create("div", "legend");
    div.style.background = "rgba(255,255,255,0.92)";
    div.style.padding = "10px 12px";
    div.style.borderRadius = "10px";
    div.style.lineHeight = "1.6";
    div.style.fontSize = "13px";

    div.innerHTML = `
      <b>مفتاح الخطورة (gridcode)</b><br/>
      <div><span style="display:inline-block;width:14px;height:14px;background:#2ca25f;margin-left:6px;border:1px solid #555"></span>(1) منخفضة جدًا</div>
      <div><span style="display:inline-block;width:14px;height:14px;background:#66c2a4;margin-left:6px;border:1px solid #555"></span>(2) منخفضة</div>
      <div><span style="display:inline-block;width:14px;height:14px;background:#fee08b;margin-left:6px;border:1px solid #555"></span>(3) متوسطة</div>
      <div><span style="display:inline-block;width:14px;height:14px;background:#f46d43;margin-left:6px;border:1px solid #555"></span>(4) عالية</div>
      <div><span style="display:inline-block;width:14px;height:14px;background:#d73027;margin-left:6px;border:1px solid #555"></span>(5) عالية جدًا</div>
    `;
    return div;
  };

  legend.addTo(map);
}

// ---------- Map + Layers ----------
async function loadGeoJSON(url) {
  const res = await fetch(url, { cache: "no-store" }); // يساعد ضد الكاش
  if (!res.ok) throw new Error("Failed to load " + url);
  return await res.json();
}

async function loadLayers() {
  try {
    // Zones
    try {
      const zonesData = await loadGeoJSON("Ramallh_zones.json");
      zonesLayer = L.geoJSON(zonesData, { style: zonesStyle }).addTo(map);
    } catch (e) {
      console.warn("Zones not loaded:", e);
    }

    // Roads
    try {
      const roadsData = await loadGeoJSON("Roads.json");
      roadsLayer = L.geoJSON(roadsData, { style: roadsStyle }).addTo(map);
    } catch (e) {
      console.warn("Roads not loaded:", e);
    }

    // Flood (main)
    const floodData = await loadGeoJSON("flood.json");
    floodDataGlobal = floodData;

    floodLayer = L.geoJSON(floodData, { style: floodStyle }).addTo(map);

    // Zoom directly to study area (fix "world view")
    map.fitBounds(floodLayer.getBounds(), { padding: [20, 20] });

    // Layer control
    const overlays = {};
    if (roadsLayer) overlays["الطرق"] = roadsLayer;
    if (zonesLayer) overlays["المحافظة"] = zonesLayer;
    if (floodLayer) overlays["مؤشر الخطورة (flood)"] = floodLayer;

    L.control.layers({ "OSM": baseLayer }, overlays, { collapsed: true }).addTo(map);

    showStatus("اختاري نقطة البداية ثم نقطة النهاية على الخريطة.");

  } catch (err) {
    console.error(err);
    alert("في مشكلة بتحميل الملفات. تأكدي من أسماء الملفات داخل GitHub وأنهم نفس الاسم تمامًا.");
  }
}

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([31.9038, 35.2034], 11);

  // Base layer once + noWrap to avoid repeated worlds
  baseLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap",
    noWrap: true
  }).addTo(map);

  // addTopLeftControls();
  addLegend();
  loadLayers();

  // Pick start/end points
  map.on("click", (e) => {
    if (!startLatLng) {
      startLatLng = e.latlng;
      startMarker = L.marker(startLatLng, { draggable: true })
        .addTo(map)
        .bindPopup("Start")
        .openPopup();

      startMarker.on("dragend", () => {
        startLatLng = startMarker.getLatLng();
        clearRoute();
        showStatus('تم تعديل نقطة البداية. اضغطي "احسب المسار".');
      });

      showStatus("اختاري نقطة النهاية.");
      return;
    }

    if (!endLatLng) {
      endLatLng = e.latlng;
      endMarker = L.marker(endLatLng, { draggable: true })
        .addTo(map)
        .bindPopup("End")
        .openPopup();

      endMarker.on("dragend", () => {
        endLatLng = endMarker.getLatLng();
        clearRoute();
        showStatus('تم تعديل نقطة النهاية. اضغطي "احسب المسار".');
      });

      showStatus('جاهزة ✅ اضغطي "احسب المسار".');
      return;
    }

    // Third click updates end point
    endLatLng = e.latlng;
    if (endMarker) endMarker.setLatLng(endLatLng);
    clearRoute();
    showStatus('تم تحديث نقطة النهاية. اضغطي "احسب المسار".');
  });
}

// ---------- Landing / Status ----------
function ensureStatusBox() {
  if ($("statusBox")) return;

  const mapEl = $("map");
  if (!mapEl) return;

  const box = document.createElement("div");
  box.id = "statusBox";
  box.style.position = "absolute";
  box.style.left = "12px";
  box.style.bottom = "12px";
  box.style.zIndex = "999";
  box.style.background = "rgba(0,0,0,0.65)";
  box.style.color = "#fff";
  box.style.padding = "8px 10px";
  box.style.borderRadius = "10px";
  box.style.fontSize = "13px";
  box.style.maxWidth = "340px";
  box.style.lineHeight = "1.6";
  box.textContent = "جاري التحميل...";

  const parent = mapEl.parentElement;
  if (parent) parent.style.position = "relative";
  parent?.appendChild(box);
}

function setupLandingIfExists() {
  const landing = $("landing");
  const startBtn = $("startBtn");
  const howBtn = $("howBtn");
  const howText = $("howText");

  // IMPORTANT: some templates hide/show #mapWrap not #map
  const mapWrap = $("mapWrap");
  const mapEl = $("map");

  // No landing? run map directly
  if (!landing || !startBtn || !mapEl) {
    initMap();
    return;
  }

  // hide map container at start
  if (mapWrap) mapWrap.style.display = "none";
  else mapEl.style.display = "none";

  if (howBtn && howText) {
    howBtn.addEventListener("click", () => {
      howText.style.display = (howText.style.display === "none") ? "block" : "none";
    });
  }

  startBtn.addEventListener("click", () => {
    landing.style.display = "none";
    if (mapWrap) mapWrap.style.display = "block";
    else mapEl.style.display = "block";

    initMap();

    setTimeout(() => {
      map.invalidateSize();
    }, 200);
  });
}

// ---------- Start ----------
window.addEventListener("DOMContentLoaded", () => {
  ensureStatusBox();
  setupLandingIfExists();
});

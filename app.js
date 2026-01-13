/* ===============================
   Safe Route App (Leaflet + ORS)
   Noor GIS Project
   =============================== */

let map;
let baseLayer;

let zonesLayer, roadsLayer, floodLayer;
let floodDataGlobal = null;

let startMarker = null;
let endMarker = null;
let routeLayer = null;

let startLatLng = null;
let endLatLng = null;

// -------------- Helpers --------------
function $(id) {
  return document.getElementById(id);
}

// ألوان حسب gridcode (1..5)
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
    color: "#444",
    weight: 0.5,
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

function showStatus(msg) {
  const el = $("statusBox");
  if (el) el.textContent = msg;
}

// -------------- ORS Routing --------------
async function fetchORSRoute(start, end, avoidGeojson = null) {
  const url = "https://api.openrouteservice.org/v2/directions/driving-car/geojson";

  const body = {
    coordinates: [
      [start.lng, start.lat],
      [end.lng, end.lat]
    ]
  };

  if (avoidGeojson) {
    body.options = { avoid_polygons: avoidGeojson };
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

// تجهيز مناطق الخطر (gridcode 4 و 5 فقط)
function buildHighRiskAvoidPolygons(floodFeatureCollection) {
  if (!floodFeatureCollection?.features?.length) return null;

  const high = floodFeatureCollection.features.filter(f => {
    const g = Number(f?.properties?.gridcode);
    return g >= 4; // 4 و 5 خطر
  });

  // إذا ما في خطر عالي، ما داعي للتجنب
  if (!high.length) return null;

  return {
    type: "FeatureCollection",
    features: high
  };
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

  // زوم على المسار
  map.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });
}

// -------------- Routing Logic --------------
async function calculateSafeRoute() {
  if (!startLatLng || !endLatLng) {
    alert("لازم تختاري نقطتين: البداية والنهاية.");
    return;
  }

  if (!floodDataGlobal) {
    alert("طبقة الخطورة (flood) لم تُحمّل بعد. انتظري ثواني وحاولي.");
    return;
  }

  showStatus("جاري حساب المسار الآمن...");

  const avoid = buildHighRiskAvoidPolygons(floodDataGlobal);

  try {
    // 1) جرّبي أولاً مسار آمن (يتجنب مناطق gridcode 4-5)
    const safeRoute = await fetchORSRoute(startLatLng, endLatLng, avoid);
    drawRoute(safeRoute, true);
    showStatus("✅ تم إيجاد مسار آمن يتجنب مناطق الخطورة العالية قدر الإمكان.");
  } catch (e) {
    console.warn("Safe route failed, fallback to normal route:", e);

    try {
      // 2) إذا فشل، ارجعي لمسار عادي مع تحذير
      const normalRoute = await fetchORSRoute(startLatLng, endLatLng, null);
      drawRoute(normalRoute, false);
      showStatus("⚠️ لم يتم العثور على مسار بديل يتجنب مناطق الخطر بالكامل. تم عرض أفضل مسار متاح مع تحذير.");
    } catch (e2) {
      console.error("Normal route failed:", e2);
      showStatus("❌ فشل حساب المسار. تأكدي من مفتاح ORS أو الإنترنت.");
      alert("فشل حساب المسار. افتحي Console وشوفي الخطأ (F12).");
    }
  }
}

// -------------- UI Controls --------------
function addTopLeftControls() {
  const control = L.control({ position: "topleft" });

  control.onAdd = function () {
    const div = L.DomUtil.create("div", "map-controls");
    div.style.display = "flex";
    div.style.gap = "8px";

    const resetBtn = L.DomUtil.create("button", "btn", div);
    resetBtn.textContent = "Reset";
    resetBtn.style.padding = "6px 10px";
    resetBtn.style.cursor = "pointer";

    const calcBtn = L.DomUtil.create("button", "btn", div);
    calcBtn.textContent = "احسب المسار";
    calcBtn.style.padding = "6px 10px";
    calcBtn.style.cursor = "pointer";

    L.DomEvent.disableClickPropagation(div);

    resetBtn.onclick = () => resetAll();
    calcBtn.onclick = () => calculateSafeRoute();

    return div;
  };

  control.addTo(map);
}

// -------------- Legend --------------
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

// -------------- Map Init --------------
function initMap() {
  // ملاحظة: ما نعمل setView بعيد عالعالم — نخليها على رام الله مؤقتاً
  map = L.map("map", { zoomControl: true }).setView([31.9038, 35.2034], 11);

  // طبقة الأساس مرة واحدة فقط
  baseLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap",
    noWrap: true
  }).addTo(map);

  // صندوق حالة (لو موجود)
  showStatus("اختاري نقطة البداية ثم نقطة النهاية على الخريطة.");

  // تحكمات فوق يسار
  addTopLeftControls();

  // Legend
  addLegend();

  // تحميل الطبقات
  loadLayers();

  // اختيار نقطتين بالكبسات
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

    // لو اختارت 3 مرات، اعتبريها إعادة اختيار النهاية
    endLatLng = e.latlng;
    if (endMarker) endMarker.setLatLng(endLatLng);
    clearRoute();
    showStatus('تم تحديث نقطة النهاية. اضغطي "احسب المسار".');
  });
}

// -------------- Load Layers --------------
async function loadGeoJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load " + url);
  return await res.json();
}

async function loadLayers() {
  try {
    // Zones (اختياري)
    try {
      const zonesData = await loadGeoJSON("Ramallh_zones.json");
      zonesLayer = L.geoJSON(zonesData, { style: zonesStyle }).addTo(map);
    } catch (e) {
      console.warn("Zones not loaded:", e);
    }

    // Roads (اختياري)
    try {
      const roadsData = await loadGeoJSON("Roads.json");
      roadsLayer = L.geoJSON(roadsData, { style: roadsStyle });
      // خليها بدون addTo إذا مش بدك تظهر تلقائي، بس أنا رح أظهرها:
      roadsLayer.addTo(map);
    } catch (e) {
      console.warn("Roads not loaded:", e);
    }

    // Flood (أساسي)
    const floodData = await loadGeoJSON("flood.json");
    floodDataGlobal = floodData;

    floodLayer = L.geoJSON(floodData, { style: floodStyle }).addTo(map);

    // زوم تلقائي على منطقة الدراسة
    map.fitBounds(floodLayer.getBounds(), { padding: [20, 20] });

    // Layer control
    const overlays = {};
    if (roadsLayer) overlays["الطرق"] = roadsLayer;
    if (zonesLayer) overlays["المحافظة"] = zonesLayer;
    if (floodLayer) overlays["مؤشر الخطورة (flood)"] = floodLayer;

    L.control.layers({ "OSM": baseLayer }, overlays, { collapsed: true }).addTo(map);

  } catch (err) {
    console.error(err);
    alert("في مشكلة بتحميل الملفات. تأكدي من أسماء الملفات داخل GitHub وأنهم نفس الاسم تمامًا.");
  }
}

// -------------- Landing Screen (اختياري) --------------
function setupLandingIfExists() {
  const landing = $("landing");
  const startBtn = $("startBtn");
  const howBtn = $("howBtn");
  const howText = $("howText");
  const mapDiv = $("map");

  // لو ما في Landing أصلاً، كمل عادي
  if (!landing || !startBtn || !mapDiv) {
    initMap();
    return;
  }

  // خفي الخريطة بالبداية
  mapDiv.style.display = "none";

  if (howBtn && howText) {
    howBtn.addEventListener("click", () => {
      howText.style.display = howText.style.display === "none" ? "block" : "none";
    });
  }

  startBtn.addEventListener("click", () => {
    landing.style.display = "none";
    mapDiv.style.display = "block";
    initMap();

    // مهم حتى Leaflet يرسم صح بعد إظهار الديف
    setTimeout(() => {
      map.invalidateSize();
    }, 200);
  });
}

// -------------- Status Box (اختياري) --------------
function ensureStatusBox() {
  // إذا ما عندك عنصر statusBox بالـ HTML، بنضيفه تلقائي
  if ($("statusBox")) return;

  const mapDiv = $("map");
  if (!mapDiv) return;

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

  // لازم يكون map container position relative
  const parent = mapDiv.parentElement;
  if (parent) parent.style.position = "relative";

  parent.appendChild(box);
}

// -------------- Start --------------
window.addEventListener("DOMContentLoaded", () => {
  ensureStatusBox();
  setupLandingIfExists();
});

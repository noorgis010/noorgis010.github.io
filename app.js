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

// --- User location tracking ---
let userMarker = null;
let watchId = null;

// Warning settings
let lastWarnTime = 0;
const WARN_COOLDOWN_MS = 15000;      // لا تكرري التحذير أسرع من 15 ثانية
const WARNING_DISTANCE_M = 120;      // مسافة التحذير بالمتر (عدليها)
const HIGH_RISK_MIN = 4;             // gridcode >= 4 يعتبر عالي

// ---------- Helpers ----------
function getInputLatLng() {
  const lat = parseFloat(document.getElementById("latInput")?.value);
  const lng = parseFloat(document.getElementById("lngInput")?.value);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return L.latLng(lat, lng);
}

function $(id) {
  return document.getElementById(id);
}

function showStatus(msg) {
  const el = $("statusBox");
  if (el) el.textContent = msg;
}

function setMsg(text) {
  const msg = $("msg");
  if (!msg) return;
  msg.style.display = "block";
  msg.textContent = text;
}

function clearMsg() {
  const msg = $("msg");
  if (!msg) return;
  msg.style.display = "none";
  msg.textContent = "";
}

function clearRoute() {
  if (routeLayer) {
    map.removeLayer(routeLayer);
    routeLayer = null;
  }
}

function resetEndOnly() {
  // نرجّع فقط النهاية + المسار
  if (endMarker) map.removeLayer(endMarker);
  endMarker = null;
  endLatLng = null;
  clearRoute();
  clearMsg();

  if (startLatLng) {
    showStatus("✅ البداية هي موقعك الحالي. الآن اختاري نقطة النهاية على الخريطة.");
  } else {
    showStatus("📍 جاري تحديد موقعك كبداية...");
  }
}

function resetAll() {
  // لو بدك Reset كامل
  if (startMarker) map.removeLayer(startMarker);
  if (endMarker) map.removeLayer(endMarker);
  if (userMarker) map.removeLayer(userMarker);

  startMarker = null;
  endMarker = null;
  userMarker = null;

  startLatLng = null;
  endLatLng = null;

  clearRoute();
  clearMsg();
  stopWatchingUserLocation();

  showStatus("📍 جاري تحديد موقعك كبداية...");
  startWatchingUserLocation(); // مباشرة ارجعي خذي الموقع
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
  return { color: "#2c3e50", weight: 1, fillOpacity: 0, dashArray: "4,2" };
}

function roadsStyle() {
  return { color: "#ffffff", weight: 2, opacity: 0.7 };
}

// ---------- ORS helpers ----------
// ORS expects avoid_polygons as a GEOMETRY (Polygon/MultiPolygon), not FeatureCollection.
function buildAvoidPolygonsGeometry(floodFC) {
  if (!floodFC?.features?.length) return null;

  const highs = floodFC.features.filter(f => Number(f?.properties?.gridcode) >= HIGH_RISK_MIN);
  if (!highs.length) return null;

  const multiCoords = [];

  for (const f of highs) {
    const geom = f?.geometry;
    if (!geom) continue;

    if (geom.type === "Polygon") {
      multiCoords.push(geom.coordinates);
    } else if (geom.type === "MultiPolygon") {
      for (const poly of geom.coordinates) multiCoords.push(poly);
    }
  }

  if (!multiCoords.length) return null;
  return { type: "MultiPolygon", coordinates: multiCoords };
}

async function fetchORSRoute(start, end, avoidGeometry = null) {
  const url = "https://api.openrouteservice.org/v2/directions/driving-car/geojson";

  const body = {
    coordinates: [
      [start.lng, start.lat],
      [end.lng, end.lat]
    ],
    radiuses: [2000, 2000]
  };

  if (avoidGeometry) {
    body.options = { avoid_polygons: avoidGeometry };
  }

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
  if (!startLatLng) {
    alert("📍 لم يتم تحديد موقعك بعد. انتظري ثواني واسمحي بالموقع.");
    return;
  }
  if (!endLatLng) {
    alert("اختاري نقطة النهاية على الخريطة.");
    return;
  }
  if (!floodDataGlobal) {
    alert("طبقة الخطورة لم تُحمّل بعد. انتظري ثواني.");
    return;
  }

  showStatus("جاري حساب المسار الآمن...");

  const avoidGeom = buildAvoidPolygonsGeometry(floodDataGlobal);

  try {
    // 1) Safe route
    const safeRoute = await fetchORSRoute(startLatLng, endLatLng, avoidGeom);
    drawRoute(safeRoute, true);

    const meters = safeRoute?.features?.[0]?.properties?.summary?.distance;
    if (meters != null) {
      const km = (meters / 1000).toFixed(2);
      showStatus(`✅ تم إيجاد مسار آمن. طول المسار: ${meters.toFixed(0)} م (${km} كم)`);
      setMsg(`✅ مسار آمن: ${meters.toFixed(0)} م (${km} كم)`);
    }
  } catch (e) {
    console.warn("Safe route failed:", e);

    try {
      // 2) Fallback normal route
      const normalRoute = await fetchORSRoute(startLatLng, endLatLng, null);
      drawRoute(normalRoute, false);

      const meters2 = normalRoute?.features?.[0]?.properties?.summary?.distance;
      if (meters2 != null) {
        const km2 = (meters2 / 1000).toFixed(2);
        showStatus(`⚠️ مسار متاح (قد يمر بمناطق خطرة). طول المسار: ${meters2.toFixed(0)} م (${km2} كم)`);
        setMsg(`⚠️ مسار عادي: ${meters2.toFixed(0)} م (${km2} كم)`);
      }
    } catch (e2) {
      console.error("Normal route failed:", e2);
      showStatus("❌ فشل حساب المسار. تأكدي من المفتاح/الإنترنت/نقطة النهاية قرب طريق.");
      alert("فشل حساب المسار. افتحي Console (F12) وشوفي الخطأ.");
    }
  }
}

// ---------- Google Maps directions ----------
function openInGoogleMaps() {
  if (!startLatLng) {
    alert("📍 لم يتم تحديد موقعك بعد.");
    return;
  }
  if (!endLatLng) {
    alert("اختاري نقطة النهاية أولاً.");
    return;
  }

  const origin = `${startLatLng.lat},${startLatLng.lng}`;
  const destination = `${endLatLng.lat},${endLatLng.lng}`;

  // Google Maps Directions (بدون API)
  const url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=driving`;
  window.open(url, "_blank");
}

// ---------- Geolocation + Warning ----------
function updateUserMarker(latlng) {
  if (!userMarker) {
    userMarker = L.circleMarker(latlng, {
      radius: 7,
      weight: 2,
      fillOpacity: 0.9
    }).addTo(map).bindPopup("You");
  } else {
    userMarker.setLatLng(latlng);
  }
}

function setStartFromUserLocation(latlng) {
  startLatLng = latlng;

  if (startMarker) map.removeLayer(startMarker);
  startMarker = L.marker(startLatLng, { draggable: false })
    .addTo(map)
    .bindPopup("Start (My Location)")
    .openPopup();
}

function warnIfNearFloodRisk(latlng) {
  // لازم turf موجودة
  if (!floodDataGlobal || typeof turf === "undefined") return;

  const highRiskGeom = buildAvoidPolygonsGeometry(floodDataGlobal);
  if (!highRiskGeom) return;

  const now = Date.now();
  if (now - lastWarnTime < WARN_COOLDOWN_MS) return;

  try {
    const pt = turf.point([latlng.lng, latlng.lat]);
    const buffered = turf.buffer(highRiskGeom, WARNING_DISTANCE_M, { units: "meters" });
    const near = turf.booleanPointInPolygon(pt, buffered);

    if (near) {
      lastWarnTime = now;
      showStatus(`⚠️ تحذير: أنت قريب من منطقة خطورة فيضان عالية (ضمن ~${WARNING_DISTANCE_M}م).`);
      alert(`⚠️ تحذير: اقتربت من منطقة خطورة فيضان عالية (≈ ${WARNING_DISTANCE_M} متر).`);
    }
  } catch (e) {
    console.warn("Risk warning failed:", e);
  }
}

function startWatchingUserLocation() {
  if (!navigator.geolocation) {
    alert("المتصفح لا يدعم تحديد الموقع.");
    return;
  }
  if (watchId !== null) return;

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const latlng = L.latLng(pos.coords.latitude, pos.coords.longitude);

      // تحديث مؤشر المستخدم
      updateUserMarker(latlng);

      // كل مرة: خلي البداية موقع المستخدم الحالي (حسب طلبك)
      setStartFromUserLocation(latlng);

      // لو النهاية موجودة والمسار مرسوم، ما بنعيد حساب تلقائي (إلا إذا بدك)
      // فقط بنعمل تنبيه اقتراب
      warnIfNearFloodRisk(latlng);

      // أول مرة نركز الخريطة حول المستخدم
      if (!map._didFlyToUserOnce) {
        map._didFlyToUserOnce = true;
        map.flyTo(latlng, 15);
      }

      // لو ما في نهاية لسه
      if (!endLatLng) {
        showStatus("✅ تم تحديد موقعك كبداية. الآن اختاري نقطة النهاية على الخريطة.");
      }
    },
    (err) => {
      console.warn("Geolocation error:", err);
      alert("تعذر الوصول لموقعك. تأكدي من السماح بالموقع وأن الموقع يعمل على HTTPS.");
      stopWatchingUserLocation();
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function stopWatchingUserLocation() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

// ---------- UI controls ----------
function addTopLeftControls() {
  const control = L.control({ position: "topleft" });

  control.onAdd = function () {
    const div = L.DomUtil.create("div", "map-controls");
    div.style.display = "flex";
    div.style.flexWrap = "wrap";
    div.style.gap = "8px";

    const resetBtn = L.DomUtil.create("button", "btn", div);
    resetBtn.textContent = "Reset";
    resetBtn.style.padding = "6px 10px";
    resetBtn.style.cursor = "pointer";

    const calcBtn = L.DomUtil.create("button", "btn", div);
    calcBtn.textContent = "احسب المسار";
    calcBtn.style.padding = "6px 10px";
    calcBtn.style.cursor = "pointer";

    const gmapsBtn = L.DomUtil.create("button", "btn", div);
    gmapsBtn.textContent = "Google Maps";
    gmapsBtn.style.padding = "6px 10px";
    gmapsBtn.style.cursor = "pointer";

    L.DomEvent.disableClickPropagation(div);

    resetBtn.onclick = () => resetEndOnly();
    calcBtn.onclick = () => calculateSafeRoute();
    gmapsBtn.onclick = () => openInGoogleMaps();

    return div;
  };

  control.addTo(map);
}

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
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load " + url);
  return await res.json();
}

async function loadLayers() {
  try {
    // Zones
    try {
      const zonesData = await loadGeoJSON("Ramallh_zones.json");
      zonesLayer = L.geoJSON(zonesData, {
        style: zonesStyle,
        onEachFeature: function (feature, layer) {
          const name = feature.properties?.Name_Engli;
          if (name) {
            layer.bindTooltip(name, {
              permanent: false,
              direction: "center",
              className: "zone-label"
            });
          }
        }
      }).addTo(map);
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

    // Layer control
    const overlays = {};
    if (roadsLayer) overlays["الطرق"] = roadsLayer;
    if (zonesLayer) overlays["المحافظة"] = zonesLayer;
    if (floodLayer) overlays["مؤشر الخطورة (flood)"] = floodLayer;

    L.control.layers({ "OSM": baseLayer }, overlays, { collapsed: true }).addTo(map);

    showStatus("📍 جاري تحديد موقعك كبداية...");
  } catch (err) {
    console.error(err);
    alert("في مشكلة بتحميل الملفات. تأكدي من أسماء الملفات داخل GitHub وأنهم نفس الاسم تمامًا.");
  }
}

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([31.9038, 35.2034], 11);

  baseLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap",
    noWrap: true
  }).addTo(map);

  addTopLeftControls();
  addLegend();
  loadLayers();

  // Go to coordinates
  const goBtn = document.getElementById("goBtn");
  if (goBtn) {
    goBtn.addEventListener("click", () => {
      const p = getInputLatLng();
      if (!p) return alert("اكتب Lat و Lng صح");
      map.flyTo(p, 15);
    });
  }

  // ✅ كل مرة: ابدأ بتحديد موقع المستخدم تلقائيًا
  startWatchingUserLocation();

  // ✅ المستخدم يختار النهاية فقط
  map.on("click", (e) => {
    // لو لسه ما أخذنا موقعه
    if (!startLatLng) {
      showStatus("📍 انتظري تحديد موقعك أولاً...");
      return;
    }

    endLatLng = e.latlng;

    if (!endMarker) {
      endMarker = L.marker(endLatLng, { draggable: true })
        .addTo(map)
        .bindPopup("End")
        .openPopup();

      endMarker.on("dragend", () => {
        endLatLng = endMarker.getLatLng();
        clearRoute();
        clearMsg();
        showStatus('تم تعديل نقطة النهاية. اضغط "احسب المسار".');
      });
    } else {
      endMarker.setLatLng(endLatLng);
    }

    clearRoute();
    clearMsg();
    showStatus('جاهز ✅ اضغط "احسب المسار".');
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

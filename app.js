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
let elevLayer, slopLayer, rainLayer, soilLayer, flowAcuLayer;
let layersControl = null;

// سنخزن GeoJSON لكل طبقة عشان نعرض جدولها لما المستخدم يشغّلها
let soilData = null, rainData = null, elevData = null, slopData = null, flowAcuData = null;

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
const WARN_COOLDOWN_MS = 15000;       // لا تكرار للتنبيه أسرع من 15 ثانية
const WARNING_DISTANCE_M = 120;       // مسافة التنبيه (متر)
const HIGH_RISK_MIN = 4;              // gridcode >= 4 خطر عالٍ

// GPS behavior
const FIRST_FIX_TIMEOUT_MS = 10000;   // مهلة أول تحديد للموقع
const PENDING_GUARD_MS = 12000;       // حارس إضافي لمنع التعليق

// ---------- Helpers ----------
function $(id) {
  return document.getElementById(id);
}

function showStatus(msg) {
  const el = $("statusBox");
  if (el) el.textContent = msg;
}
function ensureAttrPanel() {
  if (document.getElementById("attrPanel")) return;

  const mapEl = document.getElementById("map");
  if (!mapEl) return;

  const panel = document.createElement("div");
  panel.id = "attrPanel";
  panel.style.position = "absolute";
  panel.style.right = "12px";
  panel.style.bottom = "60px";
  panel.style.width = "min(560px, 92vw)";
  panel.style.maxHeight = "40vh";
  panel.style.overflow = "auto";
  panel.style.background = "rgba(255,255,255,0.95)";
  panel.style.borderRadius = "12px";
  panel.style.padding = "10px 12px";
  panel.style.zIndex = "1200";
  panel.style.boxShadow = "0 8px 24px rgba(0,0,0,0.25)";
  panel.style.fontSize = "13px";
  panel.style.direction = "rtl";
  panel.style.display = "none";

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
      <div id="attrTitle" style="font-weight:800;"></div>
      <button id="attrClose" style="border:0;border-radius:10px;padding:6px 10px;cursor:pointer;font-weight:800;">إغلاق</button>
    </div>
    <div id="attrBody" style="margin-top:8px;"></div>
  `;

  const parent = mapEl.parentElement;
  if (parent) parent.style.position = "relative";
  parent.appendChild(panel);

  document.getElementById("attrClose")?.addEventListener("click", hideAttrPanel);
}

function hideAttrPanel() {
  const panel = document.getElementById("attrPanel");
  if (!panel) return;
  panel.style.display = "none";
  const body = document.getElementById("attrBody");
  const title = document.getElementById("attrTitle");
  if (body) body.innerHTML = "";
  if (title) title.textContent = "";
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showAttributeTable(layerTitle, geojson, columns, limit = 200) {
  ensureAttrPanel();
  const panel = document.getElementById("attrPanel");
  const body = document.getElementById("attrBody");
  const title = document.getElementById("attrTitle");
  if (!panel || !body || !title) return;

  const feats = geojson?.features || [];
  const rows = feats.slice(0, limit);

  title.textContent = `جدول البيانات: ${layerTitle}`;

  let html = `<div style="margin-bottom:8px;opacity:.85;">
    عدد العناصر: ${feats.length}${feats.length > limit ? ` (يعرض أول ${limit} فقط)` : ""}
  </div>`;

  html += `<table style="width:100%;border-collapse:collapse;">`;
  html += `<thead><tr>`;
  for (const col of columns) {
    html += `<th style="border-bottom:1px solid rgba(0,0,0,0.12);padding:6px 4px;text-align:right;">${escapeHtml(col)}</th>`;
  }
  html += `</tr></thead><tbody>`;

  for (const f of rows) {
    const p = f?.properties || {};
    html += `<tr>`;
    for (const col of columns) {
      html += `<td style="border-bottom:1px solid rgba(0,0,0,0.08);padding:6px 4px;text-align:right;">${escapeHtml(p[col])}</td>`;
    }
    html += `</tr>`;
  }

  html += `</tbody></table>`;
  body.innerHTML = html;
  panel.style.display = "block";
}

function enableManualMode(reason = "لم يتم الحصول على الموقع") {
  // لا تكرر التحويل إن كان مفعّلًا
  if (map?._geoFailed) return;

  map._geoFailed = true;

  showStatus("⚠️ " + reason + " — استخدم الوضع اليدوي: اختر نقطة البداية ثم نقطة النهاية.");
  setTopPill?.("الوضع اليدوي: اختر Start ثم End.");

  // ركّز على منطقة الدراسة إن كانت محمّلة
  try {
    if (floodLayer) map.fitBounds(floodLayer.getBounds(), { padding: [20, 20] });
  } catch {}
}


function setTopPill(msg) {
  const pill = document.querySelector("#topbar .pill");
  if (pill) pill.textContent = msg;
}

function clearRoute() {
  if (routeLayer) {
    map.removeLayer(routeLayer);
    routeLayer = null;
  }
}

function resetEndOnly() {
  if (endMarker) map.removeLayer(endMarker);
  endMarker = null;
  endLatLng = null;

  clearRoute();

  if (startLatLng) {
    showStatus("✅ تم تحديد البداية من موقعك. اختر نقطة النهاية على الخريطة.");
    setTopPill("اختر نقطة النهاية فقط (البداية = موقعك).");
  } else if (map._geoFailed) {
    showStatus("⚠️ تعذر تحديد الموقع. اختر نقطة البداية ثم النهاية على الخريطة.");
    setTopPill("اختر Start ثم End يدويًا.");
  } else {
    showStatus("📍 جارٍ تحديد موقعك كبداية...");
    setTopPill("جارٍ تحديد موقعك...");
  }
}

function resetAll() {
  if (startMarker) map.removeLayer(startMarker);
  if (endMarker) map.removeLayer(endMarker);
  if (userMarker) map.removeLayer(userMarker);

  startMarker = null;
  endMarker = null;
  userMarker = null;

  startLatLng = null;
  endLatLng = null;

  clearRoute();

  map._geoFailed = false;
  stopWatchingUserLocation();

  showStatus("📍 جارٍ تحديد موقعك كبداية...");
  setTopPill("جارٍ تحديد موقعك...");
  startWatchingUserLocation(true);
}

// ---------- Flood styling ----------
function getFloodColor(gridcode) {
  const v = Number(gridcode);
  if (v === 1) return "#2ca25f";
  if (v === 2) return "#66c2a4";
  if (v === 3) return "#fee08b";
  if (v === 4) return "#f46d43";
  return "#d73027";
}
function getFiveLevelColor(v) {
  const n = Number(v);
  if (n === 1) return "#2ca25f";
  if (n === 2) return "#66c2a4";
  if (n === 3) return "#fee08b";
  if (n === 4) return "#f46d43";
  return "#d73027";
}

function makeNonInteractive(layer) {
  // يمنع الطبقة من التقاط النقرات (حتى يبقى النقر للمسار فقط)
  layer?.eachLayer?.((lyr) => {
    if (lyr.options) lyr.options.interactive = false;
    if (lyr.setStyle) lyr.setStyle({ interactive: false });
  });
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
// ORS expects avoid_polygons as GEOMETRY (Polygon/MultiPolygon), not FeatureCollection.
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
    // ✅ كبّرنا السناب لتقليل أخطاء 404
    radiuses: [6000, 6000]
  };

  if (avoidGeometry) body.options = { avoid_polygons: avoidGeometry };

  if (typeof ORS_API_KEY === "undefined" || !ORS_API_KEY) {
    throw new Error("مفتاح ORS غير موجود في config.js");
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
    // ✅ اجلب رسالة الخطأ من ORS (مهم جدًا)
    let details = "";
    try {
      details = await res.text();
    } catch {} 
    console.warn("ORS raw error:", res.status, details);
    let userMsg = "تعذّر حساب المسار. حاول مرة أخرى.";
    if (res.status === 404) {
       userMsg = "لم يُعثر على طريق بين النقطتين. اختر نقطة أقرب إلى شارع واضح ثم أعد المحاولة.";
    } else if (res.status === 401 || res.status === 403) {
      userMsg = "تعذّر استخدام خدمة المسارات بسبب مشكلة في مفتاح ORS.";
    } else if (res.status === 429) {
      userMsg = "تم تجاوز حد الاستخدام لخدمة ORS. حاول بعد قليل.";
    } else if (res.status >= 500) {
      userMsg = "خدمة المسارات غير متاحة مؤقتًا. حاول لاحقًا.";
    }


    showStatus("❌ " + userMsg);

    throw new Error(userMsg);
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
function buildGoogleMapsUrlFromRoute(routeGeojson, start, end) {
  const MAX_WP = 10;

  const coords = routeGeojson?.features?.[0]?.geometry?.coordinates;
  if (!coords || coords.length < 2) {
    return `https://www.google.com/maps/dir/?api=1&origin=${start.lat},${start.lng}&destination=${end.lat},${end.lng}&travelmode=driving`;
  }

  const step = Math.max(1, Math.floor(coords.length / (MAX_WP + 1)));
  const waypoints = [];

  for (let i = step; i < coords.length - 1 && waypoints.length < MAX_WP; i += step) {
    const [lng, lat] = coords[i];
    waypoints.push(`${lat},${lng}`);
  }

  let url = `https://www.google.com/maps/dir/?api=1&origin=${start.lat},${start.lng}&destination=${end.lat},${end.lng}&travelmode=driving`;
  if (waypoints.length) {
    url += `&waypoints=${encodeURIComponent(waypoints.join("|"))}`;
  }
  return url;
}

// ---------- Risk checks (Route + Live) ----------
function routeIntersectsHighRisk(routeGeojson) {
  // تحذير مسبق: هل المسار يمر بمناطق خطر عالية؟
  if (!routeGeojson || !floodDataGlobal || typeof turf === "undefined") return false;

  try {
    const avoidGeom = buildAvoidPolygonsGeometry(floodDataGlobal);
    if (!avoidGeom) return false;

    const line = routeGeojson?.features?.[0]?.geometry;
    if (!line) return false;

    // دعم LineString / MultiLineString
    const routeFeat = turf.feature(line);

    // فحص تقاطع (النتيجة قد تكون true حتى لو التقاطع بسيط)
    return turf.booleanIntersects(routeFeat, avoidGeom);
  } catch (e) {
    console.warn("routeIntersectsHighRisk failed:", e);
    return false;
  }
}

function warnIfNearFloodRisk(latlng) {
  // تحذير لحظي: الاقتراب من مناطق الخطر ضمن مسافة
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
    console.warn("warnIfNearFloodRisk failed:", e);
  }
}

// ---------- Calculate route ----------
async function calculateSafeRoute() {
  if (!startLatLng) {
    alert("لم يتم تحديد نقطة البداية بعد. اسمح بتحديد الموقع أو اختر البداية يدويًا.");
    return;
  }
  if (!endLatLng) {
    alert("اختر نقطة النهاية على الخريطة.");
    return;
  }
  if (!floodDataGlobal) {
    alert("طبقة الخطورة لم تُحمّل بعد. انتظر قليلًا.");
    return;
  }

  showStatus("جارٍ حساب المسار الآمن...");
  setTopPill("جارٍ حساب المسار...");

  const avoidGeom = buildAvoidPolygonsGeometry(floodDataGlobal);

  try {
    // 1) Safe route
    const safeRoute = await fetchORSRoute(startLatLng, endLatLng, avoidGeom);
    drawRoute(safeRoute, true);
    const gUrl = buildGoogleMapsUrlFromRoute(safeRoute, startLatLng, endLatLng);
    const gBtn = [...document.querySelectorAll("button")]
  .find(b => b.textContent.includes("Google")); 
   if (gBtn) {
  gBtn.onclick = () => window.open(gUrl, "_blank");
}

    const meters = safeRoute?.features?.[0]?.properties?.summary?.distance;
    const intersects = routeIntersectsHighRisk(safeRoute);

    if (meters != null) {
      const km = (meters / 1000).toFixed(2);
      if (intersects) {
        showStatus(`✅ تم إيجاد مسار (آمن نسبيًا) بطول ${meters.toFixed(0)} م (${km} كم). ⚠️ قد يلامس مناطق خطرة.`);
        setTopPill(`مسار: ${km} كم — ⚠️ قد يمر قرب/داخل خطر.`);
      } else {
        showStatus(`✅ تم إيجاد مسار آمن. طول المسار: ${meters.toFixed(0)} م (${km} كم).`);
        setTopPill(`مسار آمن: ${km} كم`);
      }
    } else {
      showStatus("✅ تم إيجاد مسار آمن.");
      setTopPill("تم إيجاد مسار آمن.");
    }

  } catch (e) {
    console.warn("Safe route failed:", e);

    try {
      // 2) Fallback normal route
      const normalRoute = await fetchORSRoute(startLatLng, endLatLng, null);
      drawRoute(normalRoute, false);

      const meters2 = normalRoute?.features?.[0]?.properties?.summary?.distance;
      const intersects2 = routeIntersectsHighRisk(normalRoute);

      if (meters2 != null) {
        const km2 = (meters2 / 1000).toFixed(2);
        if (intersects2) {
          showStatus(`⚠️ مسار متاح بطول ${meters2.toFixed(0)} م (${km2} كم) — يمر بمناطق خطرة.`);
          setTopPill(`مسار عادي: ${km2} كم — ⚠️ يمر بخطر`);
          alert("⚠️ تنبيه: المسار المتاح يمر بمناطق خطورة فيضان عالية.");
        } else {
          showStatus(`⚠️ مسار متاح (قد لا يتجنب الخطر بالكامل). طول المسار: ${meters2.toFixed(0)} م (${km2} كم).`);
          setTopPill(`مسار عادي: ${km2} كم`);
        }
      } else {
        showStatus("⚠️ تم إيجاد مسار (غير متجنب للخطر).");
        setTopPill("تم إيجاد مسار عادي.");
      }

    } catch (e2) {
      console.error("Normal route failed:", e2);
      showStatus("❌ فشل حساب المسار. تحقق من المفتاح/الإنترنت/قرب النقاط من الطرق.");
      setTopPill("فشل الحساب.");
      alert("فشل حساب المسار. افتح Console (F12) للاطلاع على الخطأ.");
    }
  }
}

// ---------- Google Maps directions ----------
function openInGoogleMaps() {
  if (!startLatLng) {
    alert("لم يتم تحديد نقطة البداية بعد.");
    return;
  }
  if (!endLatLng) {
    alert("اختر نقطة النهاية أولًا.");
    return;
  }

  const origin = `${startLatLng.lat},${startLatLng.lng}`;
  const destination = `${endLatLng.lat},${endLatLng.lng}`;

  const url =
    `https://www.google.com/maps/dir/?api=1` +
    `&origin=${encodeURIComponent(origin)}` +
    `&destination=${encodeURIComponent(destination)}` +
    `&travelmode=driving`;

  window.open(url, "_blank");
}

// ---------- Geolocation ----------
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
    .bindPopup("Start (My Location)");
}

function stopWatchingUserLocation() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

// أفضل سلوك: محاولة أول Fix سريع + منع التعليق + fallback يدوي
function startWatchingUserLocation(force = false) {
  if (!navigator.geolocation) {
    map._geoFailed = true;
    showStatus("⚠️ المتصفح لا يدعم تحديد الموقع. اختر البداية والنهاية يدويًا.");
    setTopPill("اختر Start ثم End يدويًا.");
    return;
  }
  if (watchId !== null && !force) return;

  let gotFirstFix = false;

  const failToManual = (reason) => {
    map._geoFailed = true;
    stopWatchingUserLocation();
    showStatus("⚠️ " + reason + " — سيعمل التطبيق بوضع يدوي (Start ثم End).");
    setTopPill("اختر Start ثم End يدويًا.");
    alert(reason);

    // إن كانت طبقة الفيضانات محمّلة، ركّز على منطقة الدراسة بدل البقاء على العالم
    if (floodLayer && map && !map._didFitFloodOnFail) {
      map._didFitFloodOnFail = true;
      try {
        map.fitBounds(floodLayer.getBounds(), { padding: [20, 20] });
      } catch {}
    }
  };

  showStatus("📍 جارٍ تحديد موقعك كبداية...");
  setTopPill("جارٍ تحديد موقعك...");

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      gotFirstFix = true;

      const latlng = L.latLng(pos.coords.latitude, pos.coords.longitude);

      map._geoFailed = false;

      updateUserMarker(latlng);
      setStartFromUserLocation(latlng);

      // الأفضل: الانتقال إلى موقع المستخدم حتى لو كان خارج منطقة الدراسة
      if (!map._didFlyToUserOnce) {
        map._didFlyToUserOnce = true;
        map.flyTo(latlng, 15);
      }

      showStatus("✅ تم تحديد موقعك كبداية. اختر نقطة النهاية على الخريطة.");
      setTopPill("اختر نقطة النهاية فقط (البداية = موقعك).");

      // بعد أول Fix: فعّل watch للتنبيه أثناء الحركة (ولا تعلّق التطبيق إن فشل)
      watchId = navigator.geolocation.watchPosition(
        (pos2) => {
          const ll = L.latLng(pos2.coords.latitude, pos2.coords.longitude);

          updateUserMarker(ll);

          // حسب الاتفاق: في كل مرة، اجعل البداية = موقع المستخدم الحالي
          setStartFromUserLocation(ll);

          // تحذير اقتراب
          warnIfNearFloodRisk(ll);
        },
        (err2) => {
          console.warn("watchPosition error:", err2);
          stopWatchingUserLocation();
          showStatus("⚠️ تم إيقاف تتبع الحركة. ما يزال بإمكانك حساب المسار.");
          setTopPill("التتبع متوقف — الحساب يعمل.");
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
      );
    },
    (err) => {
      console.warn("getCurrentPosition error:", err);

      if (err.code === 1) {
        failToManual("تم رفض إذن الموقع. اجعل Location = Allow ثم أعد تحميل الصفحة.");
      } else if (err.code === 2) {
        failToManual("الموقع غير متاح. فعّل خدمات الموقع في الجهاز أو جرّب من هاتف.");
      } else {
        failToManual("انتهت مهلة تحديد الموقع. أعد المحاولة أو استخدم الوضع اليدوي.");
      }
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: FIRST_FIX_TIMEOUT_MS }
  );

  // حارس لمنع التعليق إذا بقي الطلب Pending
  setTimeout(() => {
    if (!gotFirstFix && !map._geoFailed) {
      failToManual("تعذر الحصول على موقعك (تعليق طويل). غالبًا خدمات الموقع غير مفعلة أو الدقة ضعيفة.");
    }
  }, PENDING_GUARD_MS);
}

// ---------- UI controls ----------
function addTopLeftControls() {
  const control = L.control({ position: "topleft" });

  control.onAdd = function () {
    const div = L.DomUtil.create("div", "map-controls");
    div.style.display = "flex";
    div.style.flexWrap = "wrap";
    div.style.gap = "8px";

    const gmapsBtn = L.DomUtil.create("button", "btn", div);
    gmapsBtn.textContent = "Google Maps";
    gmapsBtn.style.padding = "6px 10px";
    gmapsBtn.style.cursor = "pointer";
    const locBtn = L.DomUtil.create("button", "btn", div);
    locBtn.textContent = "تحديد موقعي";
    locBtn.style.padding = "6px 10px";
    locBtn.style.cursor = "pointer";

    locBtn.onclick = () => {
      requestUserLocationOnce();
    };


    const calcBtn = L.DomUtil.create("button", "btn", div);
    calcBtn.textContent = "احسب المسار";
    calcBtn.style.padding = "6px 10px";
    calcBtn.style.cursor = "pointer";

    const resetBtn = L.DomUtil.create("button", "btn", div);
    resetBtn.textContent = "Reset";
    resetBtn.style.padding = "6px 10px";
    resetBtn.style.cursor = "pointer";

    L.DomEvent.disableClickPropagation(div);

    gmapsBtn.onclick = () => openInGoogleMaps();
    calcBtn.onclick = () => calculateSafeRoute();
    resetBtn.onclick = () => resetAll(); // يحافظ على البداية (الموقع) ويصفّر النهاية

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

    div.innerHTML = `<b id="legendTitle">Legend</b><div id="legendBody"></div>`;

    return div;
  };

  legend.addTo(map);
}
function updateLegend(title, labels) {
  const t = document.getElementById("legendTitle");
  const b = document.getElementById("legendBody");
  if (!t || !b) return;

  t.textContent = title;
  b.innerHTML = "";

  labels.forEach(l => {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";
    row.style.margin = "4px 0";

    const sw = document.createElement("span");
    sw.style.width = "14px";
    sw.style.height = "14px";
    sw.style.background = l.color;
    sw.style.border = "1px solid #555";

    const txt = document.createElement("span");
    txt.textContent = l.label;

    row.appendChild(sw);
    row.appendChild(txt);
    b.appendChild(row);
  });
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
     // --- Soil (DIS + Soil_Risk) ---
try {
  soilData = await loadGeoJSON("soil_new.json");
  soilLayer = L.geoJSON(soilData, {
    style: (f) => ({
      color: "#2b2b2b",
      weight: 0.4,
      fillColor: getFiveLevelColor(f?.properties?.Soil_Risk),
      fillOpacity: 0.50
    })
  });
  makeNonInteractive(soilLayer);
} catch (e) {
  console.warn("Soil not loaded:", e);
}

// --- Rain (Rain_Max / Rain_Min) ---
try {
  rainData = await loadGeoJSON("rain.json");
  // تلوين تقريبي حسب Rain_Max إلى 5 فئات
  const vals = (rainData.features || []).map(x => Number(x?.properties?.Rain_Max)).filter(Number.isFinite);
  const minV = vals.length ? Math.min(...vals) : 0;
  const maxV = vals.length ? Math.max(...vals) : 0;

  function rainClass(v) {
    if (!Number.isFinite(v) || maxV === minV) return 3;
    const t = (v - minV) / (maxV - minV);
    if (t <= 0.2) return 1;
    if (t <= 0.4) return 2;
    if (t <= 0.6) return 3;
    if (t <= 0.8) return 4;
    return 5;
  }

  rainLayer = L.geoJSON(rainData, {
    style: (f) => ({
      color: "#2b2b2b",
      weight: 0.4,
      fillColor: getFiveLevelColor(rainClass(Number(f?.properties?.Rain_Max))),
      fillOpacity: 0.50
    })
  });
  makeNonInteractive(rainLayer);
} catch (e) {
  console.warn("Rain not loaded:", e);
}

// --- Slope (gridcode) ---
try {
  slopData = await loadGeoJSON("slop.json");
  slopLayer = L.geoJSON(slopData, {
    style: (f) => ({
      color: "#2b2b2b",
      weight: 0.4,
      fillColor: getFiveLevelColor(f?.properties?.gridcode),
      fillOpacity: 0.50
    })
  });
  makeNonInteractive(slopLayer);
} catch (e) {
  console.warn("Slope not loaded:", e);
}

// --- Elevation (gridcode) ---
try {
  elevData = await loadGeoJSON("elev.json");
  elevLayer = L.geoJSON(elevData, {
    style: (f) => ({
      color: "#2b2b2b",
      weight: 0.4,
      
      fillColor: getFiveLevelColor(6 - Number(f?.properties?.gridcode)),

      fillOpacity: 0.50
    })
  });
  makeNonInteractive(elevLayer);
} catch (e) {
  console.warn("Elevation not loaded:", e);
}

// --- Flow accumulation (gridcode) ---
try {
  flowAcuData = await loadGeoJSON("flow_acu.json");
  flowAcuLayer = L.geoJSON(flowAcuData, {
    style: (f) => ({
      color: "#2b2b2b",
      weight: 0.4,
      fillColor: getFiveLevelColor(f?.properties?.gridcode),
      fillOpacity: 0.50
    })
  });
  makeNonInteractive(flowAcuLayer);
} catch (e) {
  console.warn("Flow not loaded:", e);
}


    // Flood (main)
    const floodData = await loadGeoJSON("flood.json");
    floodDataGlobal = floodData;

    floodLayer = L.geoJSON(floodData, { style: floodStyle }).addTo(map);

    // لا تجبر المستخدم على منطقة الدراسة إن نجح GPS
    // إن فشل GPS لاحقًا، سنعمل fitBounds هناك.
    // ومع ذلك: إن لم يبدأ GPS بعد، اجعل العرض معقولًا
    if (!map._didInitialView) {
      map._didInitialView = true;
      try {
        map.fitBounds(floodLayer.getBounds(), { padding: [20, 20] });
      } catch {}
    }

    // Layer control
    const overlays = {};
    if (roadsLayer) overlays["(Roads)الطرق"] = roadsLayer;
    if (zonesLayer) overlays["(Zones)المحافظة"] = zonesLayer;
    if (floodLayer) overlays["مؤشر الخطورة (flood)"] = floodLayer;
    if (soilLayer) overlays["التربة (Soil)"] = soilLayer;
    if (rainLayer) overlays["الأمطار (Rain)"] = rainLayer;
    if (slopLayer) overlays["الانحدار (Slope)"] = slopLayer;
    if (elevLayer) overlays["الارتفاعات (Elevation)"] = elevLayer;
    if (flowAcuLayer) overlays["تراكم الجريان (Flow Accu)"] = flowAcuLayer;


    layersControl = L.control.layers({ "OSM": baseLayer }, overlays, { collapsed: true }).addTo(map);

    showStatus("📍 جارٍ تحديد موقعك كبداية...");
    setTopPill("جارٍ تحديد موقعك...");
  } catch (err) {
    console.error(err);
    alert("مشكلة في تحميل الملفات. تحقق من أسماء ملفات GeoJSON داخل GitHub وأنها مطابقة تمامًا.");
  }
}
function requestUserLocationOnce() {
  if (!navigator.geolocation) {
    map._geoFailed = true;
    showStatus("⚠️ المتصفح لا يدعم تحديد الموقع. استخدم الوضع اليدوي (Start ثم End).");
    setTopPill("الوضع اليدوي: اختر Start ثم End.");
    return;
  }

  showStatus("📍 جارٍ تحديد موقعك... الرجاء الانتظار.");
  setTopPill("جارٍ تحديد الموقع...");

  let finished = false;

  const toManual = (reason) => {
    if (finished) return;
    finished = true;

    map._geoFailed = true;
    stopWatchingUserLocation?.();

    showStatus("⚠️ " + reason + " — استخدم الوضع اليدوي (Start ثم End).");
    setTopPill("الوضع اليدوي: اختر Start ثم End.");

    try {
      if (floodLayer) map.fitBounds(floodLayer.getBounds(), { padding: [20, 20] });
    } catch {}
  };

  // قاطع تعليق نهائي
  setTimeout(() => {
    toManual("تعذر الحصول على الموقع ضمن المهلة");
  }, 12000);

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (finished) return;
      finished = true;

      map._geoFailed = false;

      const latlng = L.latLng(pos.coords.latitude, pos.coords.longitude);
      map._geoFailed = false;

      updateUserMarker(latlng);
      setStartFromUserLocation(latlng);

      map.flyTo(latlng, 15);

      showStatus("✅ تم تحديد موقعك كبداية. اختر نقطة النهاية على الخريطة.");
      setTopPill("اختر النهاية فقط (البداية = موقعك).");

      // إذا تريد تتبّع الحركة للتنبيه
      startWatchingUserLocation?.(true);
    },
    (err) => {
      if (err?.code === 1) toManual("تم رفض إذن الموقع");
      else if (err?.code === 2) toManual("الموقع غير متاح على الجهاز");
      else toManual("انتهت مهلة تحديد الموقع");
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
  );
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
   // Legend الافتراضي عند بدء التشغيل = طبقة الخطر (flood)
updateLegend("مستويات الخطورة (gridcode)", [
  { color:"#2ca25f", label:"(1) منخفضة جدًا" },
  { color:"#66c2a4", label:"(2) منخفضة" },
  { color:"#fee08b", label:"(3) متوسطة" },
  { color:"#f46d43", label:"(4) عالية" },
  { color:"#d73027", label:"(5) عالية جدًا" }
]);

   // ✅ عند تشغيل طبقة من لوحة الطبقات: اعرض جدولها تلقائيًا
  map.on("overlayadd", (e) => {
  const layer = e.layer;
    if (layer === floodLayer) {
  updateLegend("مستويات الخطورة (gridcode)", [
    { color:"#2ca25f", label:"(1) منخفضة جدًا" },
    { color:"#66c2a4", label:"(2) منخفضة" },
    { color:"#fee08b", label:"(3) متوسطة" },
    { color:"#f46d43", label:"(4) عالية" },
    { color:"#d73027", label:"(5) عالية جدًا" }
  ]);
  return; // مهم: حتى لا يكمل لباقي الشروط
}


  if (layer === soilLayer && soilData) {
    showAttributeTable("التربة", soilData, ["DIS", "Soil_Risk"]);
    updateLegend("خطورة التربة", [
  { color:"#2ca25f", label:"منخفضة جدًا (1)" },
  { color:"#66c2a4", label:"منخفضة (2)" },
  { color:"#fee08b", label:"متوسطة (3)" },
  { color:"#f46d43", label:"عالية (4)" },
  { color:"#d73027", label:"عالية جدًا (5)" }
]);

  } else if (layer === rainLayer && rainData) {
    showAttributeTable("الأمطار", rainData, ["Rain_Max", "Rain_Min"]);
    updateLegend("معدلات الأمطار (Rain_Max)", [
  { color:"#2ca25f", label:"منخفض" },
  { color:"#66c2a4", label:"متوسط" },
  { color:"#fee08b", label:"مرتفع" },
  { color:"#f46d43", label:"مرتفع جدًا" },
  { color:"#d73027", label:"أقصى" }
]);

  } else if (layer === slopLayer && slopData) {
    
    updateLegend("مستويات الخطورة (gridcode)", [
  { color:"#2ca25f", label:"منخفض جدًا (1)" },
  { color:"#66c2a4", label:"منخفض (2)" },
  { color:"#fee08b", label:"متوسط (3)" },
  { color:"#f46d43", label:"عالي (4)" },
  { color:"#d73027", label:"عالي جدًا (5)" }
]);

  } else if (layer === elevLayer && elevData) {
    
    updateLegend("الارتفاعات (المنخفض = أخطر)", [
  { color:"#d73027", label:"عالي جدا (1)" },
  { color:"#f46d43", label:"عالي (2)" },
  { color:"#fee08b", label:"متوسط (3)" },
  { color:"#66c2a4", label:"منخفض (4)" },
  { color:"#2ca25f", label:"منخفض جدا (5)" }
]);

  } else if (layer === flowAcuLayer && flowAcuData) {
    
    updateLegend("مستويات الخطورة (gridcode)", [
  { color:"#2ca25f", label:"منخفض جدًا (1)" },
  { color:"#66c2a4", label:"منخفض (2)" },
  { color:"#fee08b", label:"متوسط (3)" },
  { color:"#f46d43", label:"عالي (4)" },
  { color:"#d73027", label:"عالي جدًا (5)" }
]);

  }
});

// ✅ عند إطفاء طبقة: أخفِ الجدول إذا كانت هي المعروضة
  map.on("overlayremove", (e) => {
  const layer = e.layer;
  if (
    layer === soilLayer ||
    layer === rainLayer ||
    layer === slopLayer ||
    layer === elevLayer ||
    layer === flowAcuLayer
  ) {
    hideAttrPanel();
    updateLegend("Legend", []);

  }
});

   // ✅ إذا لم يصل موقع خلال 10 ثوانٍ: فعّل الوضع اليدوي تلقائيًا
setTimeout(() => {
  if (!startLatLng && !map._geoFailed) {
    enableManualMode("تعذر تحديد الموقع تلقائيًا خلال المهلة");
  }
}, 10000);


  // ابدأ بتحديد موقع المستخدم تلقائيًا (الأفضل)
  // startWatchingUserLocation(false);


  // اختيار النقاط:
  // - إذا نجح GPS: المستخدم يختار End فقط.
  // - إذا فشل GPS: المستخدم يختار Start ثم End (وضع يدوي).
  map.on("click", (e) => {
    // وضع يدوي عند فشل GPS
    if (map._geoFailed) {
      if (!startLatLng) {
        startLatLng = e.latlng;
        if (startMarker) map.removeLayer(startMarker);
        startMarker = L.marker(startLatLng).addTo(map).bindPopup("Start").openPopup();

        showStatus("اختر الآن نقطة النهاية على الخريطة.");
        setTopPill("اختر End.");
        return;
      }

      // بعد وجود Start يدوي: اختر End
      endLatLng = e.latlng;
      if (!endMarker) {
        endMarker = L.marker(endLatLng, { draggable: true })
          .addTo(map)
          .bindPopup("End")
          .openPopup();

        endMarker.on("dragend", () => {
          endLatLng = endMarker.getLatLng();
          clearRoute();
          showStatus('تم تعديل نقطة النهاية. اضغط "احسب المسار".');
          setTopPill('اضغط "احسب المسار".');
        });
      } else {
        endMarker.setLatLng(endLatLng);
      }

      clearRoute();
      showStatus('جاهز ✅ اضغط "احسب المسار".');
      setTopPill('جاهز للحساب.');
      return;
    }

    // وضع GPS: End فقط
    if (!startLatLng) {
      showStatus("📍 انتظر تحديد موقعك أولًا...");
      setTopPill("انتظار الموقع...");
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
        showStatus('تم تعديل نقطة النهاية. اضغط "احسب المسار".');
        setTopPill('اضغط "احسب المسار".');
      });
    } else {
      endMarker.setLatLng(endLatLng);
    }

    clearRoute();
    showStatus('جاهز ✅ اضغط "احسب المسار".');
    setTopPill('جاهز للحساب.');
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
  box.style.maxWidth = "360px";
  box.style.lineHeight = "1.6";
  box.textContent = "جارٍ التحميل...";

  const parent = mapEl.parentElement;
  if (parent) parent.style.position = "relative";
  parent.appendChild(box);
}

function setupLandingIfExists() {
  const landing = $("landing");
  const startBtn = $("startBtn");
  const howBtn = $("howBtn");
  const howText = $("howText");

  const mapWrap = $("mapWrap");
  const mapEl = $("map");

  // إن لم توجد صفحة هبوط
  if (!landing || !startBtn || !mapEl) {
    initMap();
    return;
  }

  // إخفاء الخريطة أولًا
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

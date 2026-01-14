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


    showStatus("❌ " + msg);
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
    if (roadsLayer) overlays["الطرق"] = roadsLayer;
    if (zonesLayer) overlays["المحافظة"] = zonesLayer;
    if (floodLayer) overlays["مؤشر الخطورة (flood)"] = floodLayer;

    L.control.layers({ "OSM": baseLayer }, overlays, { collapsed: true }).addTo(map);

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

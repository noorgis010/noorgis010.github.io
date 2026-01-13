// app.js
// ================== إعدادات ==================
const FILES = {
  roads: "./Roads.json",
  flood: "./flood.json",
  zones: "./Ramallh_zones.json",
  elev: "./elev.json",
  flow: "./flow_acu.json",
  rain: "./rain.json",
  slope: "./slop.json",
  soil: "./soil_new.json",
};

// اعتبر الخطر عالي إذا gridcode >= 4 (عدّليها إذا بدك)
const UNSAFE_MIN = 4;

// ================== عناصر الواجهة ==================
const landing = document.getElementById("landing");
const mapWrap = document.getElementById("mapWrap");
const startBtn = document.getElementById("startBtn");
const howBtn = document.getElementById("howBtn");
const howText = document.getElementById("howText");
const msgBox = document.getElementById("msg");

howBtn.addEventListener("click", () => {
  howText.style.display = (howText.style.display === "none") ? "block" : "none";
});

startBtn.addEventListener("click", () => {
  landing.style.display = "none";
  mapWrap.style.display = "block";
  setTimeout(() => map.invalidateSize(), 200);
});

// ================== الخريطة ==================
const map = L.map("map", { zoomControl: true }).setView([31.9, 35.2], 10);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap"
}).addTo(map);

// طبقات
let roadsLayer, floodLayer, zonesLayer;
let extraLayers = {};
let floodFeatures; // نخزنها للفحص
let startMarker, endMarker, routeLayer;

// Legend
const legend = L.control({ position: "bottomright" });
legend.onAdd = function () {
  const div = L.DomUtil.create("div", "legend");
  div.innerHTML = `
    <b>مفتاح الخطورة (gridcode)</b>
    <div class="row"><span class="swatch" style="background:#2ca25f"></span> منخفضة جدًا (1)</div>
    <div class="row"><span class="swatch" style="background:#66c2a4"></span> منخفضة (2)</div>
    <div class="row"><span class="swatch" style="background:#fee08b"></span> متوسطة (3)</div>
    <div class="row"><span class="swatch" style="background:#f46d43"></span> عالية (4)</div>
    <div class="row"><span class="swatch" style="background:#d73027"></span> عالية جدًا (5)</div>
  `;
  return div;
};
legend.addTo(map);

function floodColor(gridcode) {
  const v = Number(gridcode);
  if (v >= 5) return "#d73027";
  if (v >= 4) return "#f46d43";
  if (v >= 3) return "#fee08b";
  if (v >= 2) return "#66c2a4";
  return "#2ca25f";
}

// ================== تحميل GeoJSON ==================
async function loadGeoJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load: ${url}`);
  return await r.json();
}

(async function initLayers() {
  try {
    // Zones
    const zones = await loadGeoJSON(FILES.zones);
    zonesLayer = L.geoJSON(zones, {
      style: { color: "#ffffff", weight: 2, fillOpacity: 0.05 }
    }).addTo(map);

    // Roads
    const roads = await loadGeoJSON(FILES.roads);
    roadsLayer = L.geoJSON(roads, {
      style: { color: "#1f78b4", weight: 2, opacity: 0.8 }
    }).addTo(map);

    // Flood (risk)
    const flood = await loadGeoJSON(FILES.flood);
    floodFeatures = flood; // نخزنها
    floodLayer = L.geoJSON(flood, {
      style: (f) => ({
        color: floodColor(f.properties?.gridcode),
        weight: 1,
        fillColor: floodColor(f.properties?.gridcode),
        fillOpacity: 0.35
      }),
      onEachFeature: (feature, layer) => {
        const gc = feature.properties?.gridcode;
        layer.bindPopup(`gridcode: <b>${gc}</b>`);
      }
    }).addTo(map);

    // Extra layers (اختياري عرضها)
    const [elev, flow, rain, slope, soil] = await Promise.all([
      loadGeoJSON(FILES.elev).catch(()=>null),
      loadGeoJSON(FILES.flow).catch(()=>null),
      loadGeoJSON(FILES.rain).catch(()=>null),
      loadGeoJSON(FILES.slope).catch(()=>null),
      loadGeoJSON(FILES.soil).catch(()=>null),
    ]);

    if (elev) extraLayers["Elevation"] = L.geoJSON(elev, { style: { color:"#aaaaaa", weight:1, fillOpacity:0.05 }});
    if (flow) extraLayers["Flow Accumulation"] = L.geoJSON(flow, { style: { color:"#00bcd4", weight:1, fillOpacity:0.05 }});
    if (rain) extraLayers["Rain"] = L.geoJSON(rain, { style: { color:"#90caf9", weight:1, fillOpacity:0.05 }});
    if (slope) extraLayers["Slope"] = L.geoJSON(slope, { style: { color:"#ffcc80", weight:1, fillOpacity:0.05 }});
    if (soil) extraLayers["Soil"] = L.geoJSON(soil, { style: { color:"#a1887f", weight:1, fillOpacity:0.05 }});

    // Layer control
    const base = {};
    const overlays = {
      "حدود المحافظة": zonesLayer,
      "الطرق": roadsLayer,
      "خريطة الخطورة (flood)": floodLayer,
      ...extraLayers
    };
    L.control.layers(base, overlays, { collapsed: false }).addTo(map);

    // Zoom to zones
    map.fitBounds(zonesLayer.getBounds());

    showMsg("جاهز ✅ اختاري نقطتين على الخريطة ثم اضغطي «احسب المسار».");

  } catch (e) {
    showMsg("حدث خطأ في تحميل الملفات. تأكدي من أسماء الملفات ومساراتها في GitHub.", true);
    console.error(e);
  }
})();

// ================== اختيار Start/End ==================
map.on("click", (e) => {
  const latlng = e.latlng;

  if (!startMarker) {
    startMarker = L.marker(latlng, { draggable: true }).addTo(map).bindPopup("Start").openPopup();
    showMsg("تم تحديد نقطة البداية. الآن حددي نقطة النهاية.");
    return;
  }

  if (!endMarker) {
    endMarker = L.marker(latlng, { draggable: true }).addTo(map).bindPopup("End").openPopup();
    showMsg("تم تحديد نقطة النهاية. اضغطي «احسب المسار».");
    return;
  }

  // إذا عندك نقطتين بالفعل: خلي النقرة الثالثة تعيد End
  endMarker.setLatLng(latlng);
  showMsg("تم تحديث نقطة النهاية. اضغطي «احسب المسار».");
});

document.getElementById("resetBtn").addEventListener("click", () => {
  if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
  if (endMarker) { map.removeLayer(endMarker); endMarker = null; }
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  showMsg("تمت إعادة الضبط. اختاري Start ثم End.");
});

document.getElementById("routeBtn").addEventListener("click", async () => {
  if (!startMarker || !endMarker) {
    showMsg("لازم تحددي نقطتين (Start و End) أولًا.", true);
    return;
  }
  if (!ORS_API_KEY || ORS_API_KEY.includes("XXXX")) {
    showMsg("ضعي مفتاح OpenRouteService في ملف config.js", true);
    return;
  }

  const s = startMarker.getLatLng();
  const t = endMarker.getLatLng();

  try {
    showMsg("جاري حساب المسار...");
    const routeGeoJSON = await getRouteORS(s, t);

    if (routeLayer) map.removeLayer(routeLayer);
    routeLayer = L.geoJSON(routeGeoJSON, {
      style: { color: "#ffffff", weight: 5, opacity: 0.95 }
    }).addTo(map);

    map.fitBounds(routeLayer.getBounds());

    // فحص التقاطع مع مناطق الخطر
    const intersects = routeIntersectsUnsafe(routeGeoJSON, floodFeatures, UNSAFE_MIN);

    if (intersects) {
      showMsg("⚠️ تنبيه: المسار يمر بمناطق خطورة عالية (gridcode 4-5). يُفضّل اختيار نقاط بديلة أو طريق آخر.", true);
    } else {
      showMsg("✅ المسار لا يمر بمناطق خطورة عالية حسب طبقة flood.");
    }

  } catch (e) {
    console.error(e);
    showMsg("تعذر حساب المسار. تأكدي من API Key ومن أن ORS يعمل.", true);
  }
});

// ================== ORS Directions ==================
async function getRouteORS(startLatLng, endLatLng) {
  const url = "https://api.openrouteservice.org/v2/directions/driving-car/geojson";

  // ORS expects [lng, lat]
  const body = {
    coordinates: [
      [startLatLng.lng, startLatLng.lat],
      [endLatLng.lng, endLatLng.lat]
    ]
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": ORS_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(txt);
  }
  return await r.json();
}

// ================== تقاطع المسار مع مناطق خطرة ==================
function routeIntersectsUnsafe(routeGeoJSON, floodGeoJSON, unsafeMin) {
  // routeGeoJSON: FeatureCollection with LineString
  const routeFeature = routeGeoJSON?.features?.[0];
  if (!routeFeature) return false;

  const routeLine = routeFeature; // GeoJSON line

  // فلترة فقط المناطق الخطرة
  const unsafePolys = floodGeoJSON.features.filter(f => Number(f.properties?.gridcode) >= unsafeMin);

  // نفحص تقاطع
  for (const poly of unsafePolys) {
    try {
      if (turf.booleanIntersects(routeLine, poly)) return true;
    } catch (e) {
      // بعض الهندسات قد تسبب خطأ، نتجاوز
      continue;
    }
  }
  return false;
}

// ================== رسائل ==================
function showMsg(text, danger=false){
  msgBox.style.display = "block";
  msgBox.textContent = text;
  msgBox.style.background = danger ? "rgba(160,0,0,0.70)" : "rgba(0,0,0,0.65)";
}

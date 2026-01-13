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

// ---------- Helpers ----------
function $(id){ return document.getElementById(id); }

function showStatus(msg){
  const el = $("statusBox");
  if (el) el.textContent = msg;
}

// ألوان حسب gridcode (1..5)
function getFloodColor(gridcode){
  const v = Number(gridcode);
  if (v === 1) return "#2ca25f";
  if (v === 2) return "#66c2a4";
  if (v === 3) return "#fee08b";
  if (v === 4) return "#f46d43";
  return "#d73027";
}

function floodStyle(feature){
  const g = feature?.properties?.gridcode;
  return { color:"#444", weight:0.5, fillColor:getFloodColor(g), fillOpacity:0.65 };
}
function zonesStyle(){ return { color:"#ffffff", weight:1.2, fillOpacity:0 }; }
function roadsStyle(){ return { color:"#ffffff", weight:2, opacity:0.7 }; }

function clearRoute(){
  if(routeLayer){ map.removeLayer(routeLayer); routeLayer = null; }
}

function resetAll(){
  if(startMarker) map.removeLayer(startMarker);
  if(endMarker) map.removeLayer(endMarker);
  startMarker = null; endMarker = null;
  startLatLng = null; endLatLng = null;
  clearRoute();
  showStatus("اختاري نقطة البداية ثم نقطة النهاية على الخريطة.");
}

// ---------- ORS ----------
async function fetchORSRoute(start, end, avoidGeometry=null){
  const url = "https://api.openrouteservice.org/v2/directions/driving-car/geojson";

  const body = {
    coordinates: [
      [start.lng, start.lat],
      [end.lng, end.lat]
    ]
  };

  // ORS بتحب geometry أكثر من FeatureCollection
  if (avoidGeometry){
    body.options = { avoid_polygons: avoidGeometry };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": ORS_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if(!res.ok){
    const t = await res.text().catch(()=> "");
    throw new Error(`ORS Error ${res.status}: ${t}`);
  }
  return await res.json();
}

// نحول مناطق gridcode 4-5 لـ MultiPolygon Geometry
function buildHighRiskAvoidGeometry(fc){
  if(!fc?.features?.length) return null;

  const coords = [];
  for(const f of fc.features){
    const g = Number(f?.properties?.gridcode);
    if(g < 4) continue;

    const geom = f.geometry;
    if(!geom) continue;

    if(geom.type === "Polygon"){
      coords.push(geom.coordinates);
    } else if(geom.type === "MultiPolygon"){
      for(const poly of geom.coordinates) coords.push(poly);
    }
  }

  if(!coords.length) return null;

  return { type: "MultiPolygon", coordinates: coords };
}

function drawRoute(routeGeojson, isSafe=true){
  clearRoute();
  routeLayer = L.geoJSON(routeGeojson, {
    style: { color: isSafe ? "#00ffd5" : "#ffcc00", weight: 5, opacity: 0.9 }
  }).addTo(map);

  map.fitBounds(routeLayer.getBounds(), { padding:[30,30] });
}

// ---------- Routing Logic ----------
async function calculateSafeRoute(){
  if(!startLatLng || !endLatLng){
    alert("لازم تختاري نقطتين: البداية والنهاية.");
    return;
  }
  if(!floodDataGlobal){
    alert("طبقة الخطورة (flood) لم تُحمّل بعد. انتظري ثواني وحاولي.");
    return;
  }

  showStatus("جاري حساب المسار...");

  const avoidGeom = buildHighRiskAvoidGeometry(floodDataGlobal);

  // 1) جرّب مسار يتجنب مناطق 4-5
  if(avoidGeom){
    try{
      const safe = await fetchORSRoute(startLatLng, endLatLng, avoidGeom);
      drawRoute(safe, true);
      showStatus("✅ تم إيجاد مسار يتجنب مناطق الخطورة العالية قدر الإمكان.");
      return;
    }catch(e){
      console.warn("Safe (avoid) route failed:", e);
      // نكمل لمسار عادي
    }
  }

  // 2) مسار عادي إذا ما في avoid أو avoid فشل
  try{
    const normal = await fetchORSRoute(startLatLng, endLatLng, null);
    drawRoute(normal, false);
    showStatus("⚠️ تم عرض مسار عادي (قد يمر بمناطق خطرة).");
  }catch(e2){
    console.error("Normal route failed:", e2);
    showStatus("❌ فشل حساب المسار. تأكدي من مفتاح ORS أو الإنترنت.");
    alert("فشل حساب المسار. افتحي Console (F12) وشوفي الخطأ.");
  }
}

// ---------- Controls ----------
function addTopLeftControls(){
  const control = L.control({ position:"topleft" });
  control.onAdd = function(){
    const div = L.DomUtil.create("div", "map-controls");
    div.style.display = "flex";
    div.style.gap = "8px";

    const resetBtn = L.DomUtil.create("button", "btn", div);
    resetBtn.textContent = "Reset";
    resetBtn.style.padding = "6px 10px";

    const calcBtn = L.DomUtil.create("button", "btn", div);
    calcBtn.textContent = "احسب المسار";
    calcBtn.style.padding = "6px 10px";

    L.DomEvent.disableClickPropagation(div);
    resetBtn.onclick = resetAll;
    calcBtn.onclick = calculateSafeRoute;
    return div;
  };
  control.addTo(map);
}

// ---------- Legend ----------
function addLegend(){
  const legend = L.control({ position:"bottomright" });
  legend.onAdd = function(){
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

// ---------- Load ----------
async function loadGeoJSON(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error("Failed to load " + url);
  return await res.json();
}

async function loadLayers(){
  try{
    // Zones (اختياري)
    try{
      const zonesData = await loadGeoJSON("Ramallh_zones.json");
      zonesLayer = L.geoJSON(zonesData, { style: zonesStyle }).addTo(map);
    }catch(e){ console.warn("Zones not loaded:", e); }

    // Roads (اختياري)
    try{
      const roadsData = await loadGeoJSON("Roads.json");
      roadsLayer = L.geoJSON(roadsData, { style: roadsStyle }).addTo(map);
    }catch(e){ console.warn("Roads not loaded:", e); }

    // Flood (أساسي)
    const floodData = await loadGeoJSON("flood.json");
    floodDataGlobal = floodData;
    floodLayer = L.geoJSON(floodData, { style: floodStyle }).addTo(map);

    // زوم تلقائي على منطقة الدراسة
    map.fitBounds(floodLayer.getBounds(), { padding:[20,20] });

    // Layer control
    const overlays = {};
    if(roadsLayer) overlays["الطرق"] = roadsLayer;
    if(zonesLayer) overlays["المحافظة"] = zonesLayer;
    if(floodLayer) overlays["مؤشر الخطورة (flood)"] = floodLayer;

    L.control.layers({ "OSM": baseLayer }, overlays, { collapsed:true }).addTo(map);

  }catch(err){
    console.error(err);
    alert("في مشكلة بتحميل الملفات. تأكدي من أسماء الملفات داخل GitHub وأنهم نفس الاسم تمامًا.");
  }
}

// ---------- Map Init ----------
function initMap(){
  // مهم: worldCopyJump يمنع “عالم مكرر” عند السحب
  map = L.map("map", { zoomControl:true, worldCopyJump:true }).setView([31.9038, 35.2034], 11);

  baseLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);

  showStatus("اختاري نقطة البداية ثم نقطة النهاية على الخريطة.");
  addTopLeftControls();
  addLegend();
  loadLayers();

  // اختيار نقطتين
  map.on("click", (e) => {
    if(!startLatLng){
      startLatLng = e.latlng;
      startMarker = L.marker(startLatLng, { draggable:true }).addTo(map).bindPopup("Start").openPopup();
      startMarker.on("dragend", ()=>{
        startLatLng = startMarker.getLatLng();
        clearRoute();
        showStatus('تم تعديل نقطة البداية. اضغطي "احسب المسار".');
      });
      showStatus("اختاري نقطة النهاية.");
      return;
    }

    if(!endLatLng){
      endLatLng = e.latlng;
      endMarker = L.marker(endLatLng, { draggable:true }).addTo(map).bindPopup("End").openPopup();
      endMarker.on("dragend", ()=>{
        endLatLng = endMarker.getLatLng();
        clearRoute();
        showStatus('تم تعديل نقطة النهاية. اضغطي "احسب المسار".');
      });
      showStatus('جاهزة ✅ اضغطي "احسب المسار".');
      return;
    }

    // تحديث النهاية
    endLatLng = e.latlng;
    endMarker.setLatLng(endLatLng);
    clearRoute();
    showStatus('تم تحديث نقطة النهاية. اضغطي "احسب المسار".');
  });
}

// ---------- Status Box ----------
function ensureStatusBox(){
  if($("statusBox")) return;

  const mapDiv = $("map");
  if(!mapDiv) return;

  const parent = mapDiv.parentElement || mapDiv;
  parent.style.position = "relative";

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

  parent.appendChild(box);
}

// ---------- Landing ----------
function setupLandingIfExists(){
  const landing = $("landing");
  const startBtn = $("startBtn");
  const howBtn = $("howBtn");
  const howText = $("howText");
  const mapWrap = $("mapWrap");

  // إذا ما في landing، افتح مباشرة
  if(!landing || !startBtn || !mapWrap){
    initMap();
    return;
  }

  mapWrap.style.display = "none";

  if(howBtn && howText){
    howBtn.addEventListener("click", ()=>{
      howText.style.display = (howText.style.display === "none") ? "block" : "none";
    });
  }

  startBtn.addEventListener("click", ()=>{
    landing.style.display = "none";
    mapWrap.style.display = "block";
    initMap();
    setTimeout(()=> map.invalidateSize(), 200);
  });
}

// ---------- Start ----------
window.addEventListener("DOMContentLoaded", ()=>{
  ensureStatusBox();
  setupLandingIfExists();
});

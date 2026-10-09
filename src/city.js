// Real-world city data: Open-Meteo (weather), OpenStreetMap Overpass (places),
// Nominatim (geocoding), OSM routing (routes). All free, no keys needed.
const UA = "CityPulse/1.0 (hackathon project)";
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

export function haversine(a, b, c, d) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (c - a) * r, dLng = (d - b) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// ---------- Weather + derived alerts ----------
export async function weather(lat, lng) {
  const key = `w:${lat.toFixed(2)},${lng.toFixed(2)}`;
  return cached(key, 10 * 60e3, async () => {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,relative_humidity_2m` +
      `&hourly=precipitation_probability&forecast_days=1&timezone=auto`;
    const j = await (await fetch(u)).json();
    const c = j.current || {};
    const maxRain = Math.max(0, ...(j.hourly?.precipitation_probability || [0]));
    const alerts = [];
    if (c.weather_code >= 95) alerts.push({ level: "high", text: "Thunderstorm in the area. Stay indoors and avoid open ground." });
    if (maxRain >= 60 || c.precipitation > 1) alerts.push({ level: "medium", text: `Rain likely today (up to ${maxRain}%). Expect waterlogging and slow traffic.` });
    if (c.apparent_temperature >= 38) alerts.push({ level: "medium", text: `Feels like ${Math.round(c.apparent_temperature)}°C. Carry water and avoid midday walks.` });
    if (c.wind_speed_10m >= 40) alerts.push({ level: "medium", text: "Strong winds. Avoid hoardings, trees and two-wheelers." });
    return {
      temp: c.temperature_2m, feels_like: c.apparent_temperature, humidity: c.relative_humidity_2m,
      rain_now_mm: c.precipitation, wind_kmh: c.wind_speed_10m, code: c.weather_code,
      rain_chance_max: maxRain, alerts,
    };
  });
}

// ---------- Places (OSM Overpass) ----------
const FILTERS = {
  food: `nwr["amenity"~"^(restaurant|cafe|fast_food|food_court|ice_cream)$"]`,
  hotel: `nwr["tourism"~"^(hotel|hostel|guest_house|motel)$"]`,
  attraction: `nwr["tourism"~"^(attraction|museum|viewpoint|zoo|theme_park|gallery|artwork)$"]`,
  heritage: `nwr["historic"]`,
};
export const PLACE_TYPES = Object.keys(FILTERS);

export async function places(lat, lng, type, radius = 2000, limit = 40) {
  if (!FILTERS[type]) throw Object.assign(new Error("Unknown place type."), { status: 400 });
  radius = Math.min(Math.max(radius, 300), 8000);
  const key = `p:${type}:${lat.toFixed(3)},${lng.toFixed(3)}:${radius}`;
  return cached(key, 15 * 60e3, async () => {
    const q = `[out:json][timeout:20];${FILTERS[type]}(around:${radius},${lat},${lng});out center ${limit * 2};`;
    const r = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(q),
    });
    if (!r.ok) throw Object.assign(new Error("Map data service is busy. Try again in a moment."), { status: 503 });
    const j = await r.json();
    return j.elements
      .filter((e) => e.tags?.name)
      .map((e) => {
        const la = e.lat ?? e.center?.lat, ln = e.lon ?? e.center?.lon;
        return {
          key: `${e.type[0]}${e.id}`, name: e.tags.name, type, lat: la, lng: ln,
          distance_m: Math.round(haversine(lat, lng, la, ln)),
          sub: e.tags.cuisine || e.tags.tourism || e.tags.historic || e.tags.amenity || "",
          hours: e.tags.opening_hours || null, website: e.tags.website || null,
          wheelchair: e.tags.wheelchair || null, stars: e.tags.stars || null,
          heritage: e.tags.heritage || e.tags["heritage:operator"] || null,
        };
      })
      .sort((a, b) => a.distance_m - b.distance_m)
      .slice(0, limit);
  });
}

// ---------- Geocoding ----------
export async function geocode(q, lat, lng) {
  const bias = lat != null ? `&viewbox=${lng - 0.5},${lat + 0.5},${lng + 0.5},${lat - 0.5}` : "";
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}${bias}`, { headers: { "User-Agent": UA } });
  const j = await r.json();
  return j.map((x) => ({ name: x.display_name, lat: +x.lat, lng: +x.lon }));
}

// ---------- Routing + safety scoring ----------
export async function routes(from, to, mode = "foot") {
  const prof = { foot: "foot", bike: "bike", car: "car" }[mode] || "foot";
  const base = process.env.ROUTING_BASE || "https://routing.openstreetmap.de";
  const u = `${base}/routed-${prof}/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?alternatives=true&overview=full&geometries=geojson`;
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  const j = await r.json();
  if (j.code !== "Ok") throw Object.assign(new Error("No route found between those points."), { status: 404 });
  return j.routes.map((x) => ({
    distance_m: Math.round(x.distance), duration_s: Math.round(x.duration),
    coords: x.geometry.coordinates.map(([ln, la]) => [la, ln]),
  }));
}

const HALF_LIFE_DAYS = 7;
export function reportWeight(rep, now = Date.now() / 1000) {
  const ageDays = (now - rep.created_at) / 86400;
  return rep.severity * (0.3 + rep.credibility) * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

export function scoreRoute(coords, reports, thresholdM = 150) {
  const step = Math.max(1, Math.floor(coords.length / 200));
  const pts = coords.filter((_, i) => i % step === 0);
  let risk = 0; const hits = [];
  for (const rep of reports) {
    let min = Infinity;
    for (const p of pts) { const d = haversine(p[0], p[1], rep.lat, rep.lng); if (d < min) min = d; if (min < 30) break; }
    if (min <= thresholdM) { risk += reportWeight(rep) * (1 - min / (thresholdM * 1.5)); hits.push({ id: rep.id, category: rep.category, severity: rep.severity, distance_m: Math.round(min) }); }
  }
  return { risk: +risk.toFixed(2), hits };
}

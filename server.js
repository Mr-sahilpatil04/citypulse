import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import db from "./src/db.js";
import { register, login, requireAuth, optionalAuth } from "./src/auth.js";
import * as city from "./src/city.js";
import * as ai from "./src/ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });
const INDEX = path.join(__dirname, "public", "index.html");

const app = express();
app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://fonts.googleapis.com"],
      fontSrc: ["https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://api.mapbox.com", "https://*.tiles.mapbox.com", "https://unpkg.com", "https://images.unsplash.com"],
      mediaSrc: ["'self'", "blob:"],
      connectSrc: ["'self'", "https://api.mapbox.com"],
    },
  },
}));
app.use(cors());
app.use(express.json({ limit: "12mb" }));
app.use("/uploads", express.static(UPLOADS));
app.get("/", (_req, res) => {
  const html = fs.readFileSync(INDEX, "utf8").replace("__MAPBOX_TOKEN__", process.env.MAPBOX_TOKEN || "");
  res.type("html").send(html);
});
app.use(express.static(path.join(__dirname, "public")));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 120 }));
const aiLimit = rateLimit({ windowMs: 60_000, limit: 15, message: { error: "Too many AI requests. Wait a minute." } });
const authLimit = rateLimit({ windowMs: 15 * 60_000, limit: 30, message: { error: "Too many attempts. Try again later." } });

const h = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
  console.error(req.method, req.path, e.message);
  res.status(e.status || 500).json({ error: e.message || "Server error" });
});
const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
const num = (v, name) => { const n = Number(v); if (!Number.isFinite(n)) throw bad(`${name} must be a number.`); return n; };
const geo = (q) => { const lat = num(q.lat, "lat"), lng = num(q.lng, "lng"); if (Math.abs(lat) > 90 || Math.abs(lng) > 180) throw bad("Coordinates out of range."); return [lat, lng]; };
const geoPair = (value, name) => {
  const parts = String(value || "").split(",");
  if (parts.length !== 2) throw bad(`${name} must be 'lat,lng'.`);
  return geo({ lat: parts[0], lng: parts[1] });
};

// ---------- Auth ----------
app.post("/api/auth/register", authLimit, h((req, res) => res.json(register(req.body))));
app.post("/api/auth/login", authLimit, h((req, res) => res.json(login(req.body))));
app.get("/api/me", requireAuth, (req, res) => res.json({ id: req.user.id, name: req.user.name, email: req.user.email }));

// ---------- City data ----------
app.get("/api/weather", h(async (req, res) => res.json(await city.weather(...geo(req.query)))));
app.get("/api/geocode", h(async (req, res) => {
  const q = String(req.query.q || "").trim(); if (!q) throw bad("Enter a place to search.");
  const near = req.query.lat ? geo(req.query) : [];
  res.json(await city.geocode(q, near[0], near[1]));
}));
app.get("/api/explore", h(async (req, res) => {
  const [lat, lng] = geo(req.query);
  res.json(await city.places(lat, lng, String(req.query.type || "food"), Number(req.query.radius) || 2000));
}));
app.get("/api/story", aiLimit, h(async (req, res) => {
  const name = String(req.query.name || "").slice(0, 120); if (!name) throw bad("Missing place name.");
  const [lat, lng] = geo(req.query);
  res.json(await ai.story(name, lat, lng));
}));

// ---------- Reports ----------
const MIMES = { image: ["image/jpeg", "image/png", "image/webp"], audio: ["audio/wav", "audio/mpeg", "audio/ogg"] };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const SELECT_REPORTS = `SELECT r.id,r.lat,r.lng,r.category,r.severity,r.summary,r.transcript,r.tags,r.credibility,r.photo,r.created_at,
  (SELECT COUNT(*) FROM confirmations c WHERE c.report_id=r.id) AS confirmations, u.name AS reporter
  FROM reports r JOIN users u ON u.id=r.user_id`;

function nearbyReports(lat, lng, radiusM, days = 14) {
  const dLat = radiusM / 111000, dLng = radiusM / (111000 * Math.cos((lat * Math.PI) / 180));
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  return db.prepare(`${SELECT_REPORTS} WHERE r.lat BETWEEN ? AND ? AND r.lng BETWEEN ? AND ? AND r.created_at>=? ORDER BY r.created_at DESC LIMIT 300`)
    .all(lat - dLat, lat + dLat, lng - dLng, lng + dLng, since)
    .filter((r) => city.haversine(lat, lng, r.lat, r.lng) <= radiusM)
    .map((r) => ({ ...r, tags: JSON.parse(r.tags || "[]") }));
}

app.get("/api/reports", h((req, res) => {
  const [lat, lng] = geo(req.query);
  res.json(nearbyReports(lat, lng, Math.min(Number(req.query.radius) || 3000, 15000)));
}));

app.post("/api/reports", requireAuth, aiLimit, h(async (req, res) => {
  const { text = "", imageBase64, imageMime, audioBase64, audioMime } = req.body;
  const [lat, lng] = geo(req.body);
  if (!String(text).trim() && !imageBase64 && !audioBase64) throw bad("Add text, a photo or a voice note.");
  if (imageBase64 && !MIMES.image.includes(imageMime)) throw bad("Photo must be JPEG, PNG or WebP.");
  if (audioBase64 && !MIMES.audio.includes(audioMime)) throw bad("Voice note must be WAV, MP3 or OGG.");
  if (imageBase64 && Buffer.byteLength(imageBase64, "base64") > MAX_IMAGE_BYTES) throw bad("Photo is too large. Choose an image under 8 MB.");
  if (audioBase64 && Buffer.byteLength(audioBase64, "base64") > MAX_AUDIO_BYTES) throw bad("Voice note is too large. Keep it under 10 MB.");

  const a = await ai.analyzeReport({ text: String(text).slice(0, 1500), imageBase64, imageMime, audioBase64, audioMime });
  if (!a.safe_to_publish) throw bad(`This report can't be published: ${a.reject_reason || "not about city conditions"}.`, 422);

  let photo = null;
  if (imageBase64) {
    photo = `${crypto.randomUUID()}.${imageMime.split("/")[1].replace("jpeg", "jpg")}`;
    fs.writeFileSync(path.join(UPLOADS, photo), Buffer.from(imageBase64, "base64"));
    photo = "/uploads/" + photo;
  }
  const evidenceBonus = (imageBase64 ? 0.1 : 0) + (audioBase64 ? 0.05 : 0);
  const cred = Math.min(1, a.credibility * 0.7 + req.user.trust * 0.3 + evidenceBonus);
  const id = db.prepare(`INSERT INTO reports(user_id,lat,lng,category,severity,summary,original_text,transcript,tags,credibility,photo) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, lat, lng, a.category, a.severity, a.summary, String(text).slice(0, 1500), a.transcript, JSON.stringify(a.tags), cred, photo).lastInsertRowid;
  res.status(201).json({ ...db.prepare(`${SELECT_REPORTS} WHERE r.id=?`).get(id), tags: a.tags, ai_used: a.ai });
}));

app.post("/api/reports/:id/confirm", requireAuth, h((req, res) => {
  const r = db.prepare("SELECT user_id FROM reports WHERE id=?").get(req.params.id);
  if (!r) throw bad("Report not found.", 404);
  if (r.user_id === req.user.id) throw bad("You can't confirm your own report.", 403);
  try { db.prepare("INSERT INTO confirmations(report_id,user_id) VALUES(?,?)").run(req.params.id, req.user.id); }
  catch { throw bad("You already confirmed this report.", 409); }
  db.prepare("UPDATE reports SET credibility=MIN(1,credibility+0.1) WHERE id=?").run(req.params.id);
  res.json({ ok: true });
}));

// ---------- Reviews + Best vs Worst ----------
app.post("/api/reviews", requireAuth, h((req, res) => {
  const b = req.body; if (!b.place_key) throw bad("Missing place.");
  const r = (k) => { const v = Math.round(Number(b[k])); if (!(v >= 1 && v <= 5)) throw bad(`${k} must be 1 to 5.`); return v; };
  db.prepare(`INSERT INTO reviews(user_id,place_key,place_name,lat,lng,safety,cleanliness,affordability,accessibility,comment) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id,place_key) DO UPDATE SET safety=excluded.safety,cleanliness=excluded.cleanliness,affordability=excluded.affordability,accessibility=excluded.accessibility,comment=excluded.comment`)
    .run(req.user.id, String(b.place_key), String(b.place_name || "").slice(0, 120), b.lat ?? null, b.lng ?? null, r("safety"), r("cleanliness"), r("affordability"), r("accessibility"), String(b.comment || "").slice(0, 400));
  res.json({ ok: true });
}));

const clamp = (v) => Math.max(1, Math.min(5, v));
app.get("/api/compare", aiLimit, h(async (req, res) => {
  const [lat, lng] = geo(req.query);
  const type = String(req.query.type || "food");
  const list = (await city.places(lat, lng, type, Number(req.query.radius) || 2000, 15));
  const incidents = nearbyReports(lat, lng, (Number(req.query.radius) || 2000) + 500);
  const rows = list.map((p) => {
    const rv = db.prepare(`SELECT COUNT(*) n, AVG(safety) s, AVG(cleanliness) c, AVG(affordability) a, AVG(accessibility) x FROM reviews WHERE place_key=?`).get(p.key);
    const near = incidents.filter((i) => city.haversine(p.lat, p.lng, i.lat, i.lng) <= 300);
    const penalty = Math.min(2, near.reduce((s, i) => s + city.reportWeight(i), 0) * 0.15);
    const wc = { yes: 4.5, limited: 3, no: 1.5 }[p.wheelchair];
    const m = {
      safety: clamp((rv.s ?? 3.5) - penalty),
      cleanliness: rv.c ?? 3,
      affordability: rv.a ?? 3,
      accessibility: rv.x ?? wc ?? 3,
    };
    const overall = (m.safety * 1.5 + m.cleanliness + m.affordability + m.accessibility) / 4.5;
    return { key: p.key, name: p.name, type, lat: p.lat, lng: p.lng, sub: p.sub, distance_m: p.distance_m,
      ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, +v.toFixed(1)])),
      overall: +overall.toFixed(2), reviews: rv.n, incidents_nearby: near.length };
  }).sort((a, b) => b.overall - a.overall);

  let explanation = null;
  if (rows.length >= 2 && req.query.explain !== "0") {
    try { explanation = await ai.explainCompare({ type, top: rows.slice(0, 3), bottom: rows.slice(-2) }); } catch (e) { console.error(e.message); }
  }
  res.json({ places: rows, explanation });
}));

// ---------- Safe route ----------
app.get("/api/safe-route", aiLimit, h(async (req, res) => {
  const from = geoPair(req.query.from, "from");
  const to = geoPair(req.query.to, "to");
  const mode = String(req.query.mode || "foot");
  const rs = await city.routes(from, to, mode);
  const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  const span = Math.max(city.haversine(from[0], from[1], to[0], to[1]) / 2 + 1000, 1500);
  const reps = nearbyReports(mid[0], mid[1], span);
  const scored = rs.map((r) => ({ ...r, ...city.scoreRoute(r.coords, reps) }));
  const fastest = scored.reduce((a, b) => (b.duration_s < a.duration_s ? b : a));
  const safest = scored.reduce((a, b) => (b.risk < a.risk || (b.risk === a.risk && b.duration_s < a.duration_s) ? b : a));
  const out = scored.map((r) => ({ ...r, label: r === safest ? "safest" : r === fastest ? "fastest" : "alternative" }));
  let advice = null;
  try {
    const wx = await city.weather(mid[0], mid[1]).catch(() => null);
    advice = await ai.explainRoutes({ mode, local_hour: new Date().getHours(), weather: wx && { temp: wx.temp, rain_chance: wx.rain_chance_max, alerts: wx.alerts },
      routes: out.map((r) => ({ label: r.label, km: +(r.distance_m / 1000).toFixed(1), minutes: Math.round(r.duration_s / 60), risk: r.risk, hazards: r.hits })) });
  } catch (e) { console.error(e.message); }
  res.json({ routes: out, advice });
}));

// ---------- AI assistant ----------
app.post("/api/chat", optionalAuth, aiLimit, h(async (req, res) => {
  const { message, history } = req.body; if (!String(message || "").trim()) throw bad("Ask a question.");
  const [lat, lng] = geo(req.body);
  const [wx, food, sights] = await Promise.all([
    city.weather(lat, lng).catch(() => null),
    city.places(lat, lng, "food", 1500, 8).catch(() => []),
    city.places(lat, lng, "attraction", 3000, 8).catch(() => []),
  ]);
  const reps = nearbyReports(lat, lng, 2500).slice(0, 10).map((r) => ({ category: r.category, severity: r.severity, summary: r.summary, confirmations: r.confirmations, age_hours: Math.round((Date.now() / 1000 - r.created_at) / 3600) }));
  const context = { local_time: new Date().toLocaleString("en-IN"), weather: wx, incidents: reps,
    food: food.map(({ name, sub, distance_m, hours }) => ({ name, sub, distance_m, hours })),
    attractions: sights.map(({ name, sub, distance_m }) => ({ name, sub, distance_m })) };
  res.json({ reply: await ai.chat({ message, history, context }) });
}));

app.get("/healthz", (_q, r) => r.send("ok"));
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`CityPulse running on http://localhost:${port}`));

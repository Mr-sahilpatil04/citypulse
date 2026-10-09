import { GoogleGenAI } from "@google/genai";
import { CATEGORIES, REPORT_TRIAGE, ROUTE_EXPLAINER, COMPARE_EXPLAINER, STORY, CONCIERGE } from "./prompts.js";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
let client;
const gemini = () => {
  if (!process.env.GEMINI_API_KEY) throw Object.assign(new Error("GEMINI_API_KEY is not set on the server."), { status: 500 });
  return (client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));
};

async function run(system, contents, { json = false, search = false, temperature } = {}) {
  const config = { systemInstruction: system, temperature: temperature ?? (json ? 0.2 : 0.6) };
  if (json) config.responseMimeType = "application/json";
  if (search) config.tools = [{ googleSearch: {} }];
  return gemini().models.generateContent({ model: MODEL, contents, config });
}
const user = (parts) => [{ role: "user", parts }];
const tag = (name, v) => `<${name}>${typeof v === "string" ? v : JSON.stringify(v)}</${name}>`;

// ---- NLP + multimodal report triage ----
export async function analyzeReport({ text, imageBase64, imageMime, audioBase64, audioMime }) {
  const parts = [{ text: tag("citizen_report", text || "(no text)") }];
  if (imageBase64) parts.push({ inlineData: { mimeType: imageMime, data: imageBase64 } });
  if (audioBase64) parts.push({ inlineData: { mimeType: audioMime, data: audioBase64 } });
  try {
    const r = await run(REPORT_TRIAGE, user(parts), { json: true });
    const o = JSON.parse(r.text);
    return {
      category: CATEGORIES.includes(o.category) ? o.category : "other",
      severity: Math.min(5, Math.max(1, Math.round(o.severity) || 2)),
      credibility: Math.min(1, Math.max(0, +o.credibility || 0.4)),
      summary: String(o.summary || text || "Citizen report").slice(0, 160),
      transcript: o.transcript || "",
      tags: Array.isArray(o.tags) ? o.tags.slice(0, 4) : [],
      safe_to_publish: o.safe_to_publish !== false,
      reject_reason: o.reject_reason || "",
      ai: true,
    };
  } catch (e) {
    console.error("triage failed:", e.message);
    // graceful fallback so the app still works if the AI is down
    return { category: "other", severity: 2, credibility: 0.3, summary: String(text || "Citizen report").slice(0, 140), transcript: "", tags: [], safe_to_publish: !!text, reject_reason: "AI unavailable", ai: false };
  }
}

export async function explainRoutes(payload) {
  const r = await run(ROUTE_EXPLAINER, user([{ text: tag("place_data", payload) }]));
  return r.text.trim();
}
export async function explainCompare(payload) {
  const r = await run(COMPARE_EXPLAINER, user([{ text: tag("place_data", payload) }]));
  return r.text.trim();
}

export async function story(name, lat, lng) {
  const q = `Tell me about "${name}" near latitude ${lat}, longitude ${lng}.`;
  let r;
  try { r = await run(STORY, user([{ text: tag("question", q) }]), { search: true }); }
  catch { r = await run(STORY, user([{ text: tag("question", q) }])); }
  const sources = (r.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
    .map((c) => c.web && { title: c.web.title, url: c.web.uri }).filter(Boolean).slice(0, 4);
  return { text: r.text.trim(), sources };
}

export async function chat({ message, history = [], context }) {
  const contents = [
    ...history.slice(-6).map((h) => ({ role: h.role === "model" ? "model" : "user", parts: [{ text: String(h.text).slice(0, 800) }] })),
    { role: "user", parts: [{ text: tag("place_data", context) + "\n" + tag("question", String(message).slice(0, 1000)) }] },
  ];
  const r = await run(CONCIERGE, contents);
  return r.text.trim();
}

# CityPulse — explore your city, safely

AI-powered city companion for the *City Life* challenge. It turns scattered city data
(maps, weather, citizen photos, voice notes, reviews) into verified, actionable insight.

## What it does (mapped to the problem statement)

| Requirement | Feature | How |
|---|---|---|
| Exploration & hospitality | Food, stays, sights near you | OpenStreetMap Overpass API, cached; Mapbox map tiles |
| History & culture | "Local story" for any landmark | Gemini + Google Search grounding, with sources |
| Safety & security | Citizen reports, hazard map, **safest route** | Gemini triage, time-decayed risk score on OSRM routes |
| Best vs worst | Ranking by safety, cleanliness, affordability, accessibility | User reviews + nearby incidents + OSM tags; Gemini explains the result |
| Smart city insights | Weather alerts, photo/voice/text reports, assistant | Open-Meteo, Gemini multimodal (image + audio + Hinglish/Marathi text) |

## Architecture

```
Browser (Leaflet map, vanilla JS)  ──►  Express API (Node 18+)
   geolocation, camera, mic              ├─ Auth: bcrypt + JWT, rate limits, helmet CSP
                                         ├─ SQLite: users, reports, confirmations, reviews
                                         ├─ Gemini (Google AI Studio key): triage, explain, story, chat
                                         └─ Open data: Open-Meteo, Overpass, Nominatim, OSM routing
```

## Run locally

```bash
npm install
cp .env.example .env        # paste your key from https://aistudio.google.com/apikey
# set MAPBOX_TOKEN to a Mapbox public token and JWT_SECRET to a long random string
npm start                    # http://localhost:8080
```

Geolocation and the microphone need `localhost` or HTTPS.

## Deploy (Google Cloud Run)

```bash
gcloud run deploy citypulse --source . --region asia-south1 --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=...,JWT_SECRET=...,DB_PATH=/tmp/city.db
```
`/tmp` is wiped on restart, so for a durable demo mount a volume or swap SQLite for Cloud SQL / Firestore (only `src/db.js` and the queries in `server.js` change).

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /api/auth/register, /api/auth/login | – | Returns `{token,user}` |
| GET | /api/weather?lat&lng | – | Weather and derived alerts |
| GET | /api/explore?lat&lng&type | – | `food`, `hotel`, `attraction`, `heritage` |
| GET | /api/story?name&lat&lng | – | Grounded history and culture blurb |
| GET/POST | /api/reports | POST | List nearby or submit (text, photo, voice) |
| POST | /api/reports/:id/confirm | yes | Crowd-verify a report |
| POST | /api/reviews | yes | Rate safety, cleanliness, affordability, accessibility |
| GET | /api/compare?lat&lng&type | – | Ranked places and AI explanation |
| GET | /api/safe-route?from&to&mode | – | Fastest vs safest route and advice |
| POST | /api/chat | optional | Context-aware assistant |

## How "verified" works

1. Gemini scores each report's credibility (specificity, evidence, consistency) and blocks spam, doxxing and off-topic posts.
2. Photo and voice evidence raise the score; reporter trust blends in.
3. Other users confirm reports (+0.1 each, capped at 1).
4. Report weight = severity × (0.3 + credibility) × 0.5^(age / 7 days), so stale reports fade.
5. Routes are scored on weights of reports within 150 m of the path.

## Prompt-injection and abuse protection

User text is wrapped in tags and system prompts tell the model to treat it as data. Output is JSON-validated, categories are allowlisted, uploads are mime-checked, and AI endpoints are rate-limited. If Gemini is down, reports still save with a basic fallback.

## Known limits (be honest with judges)

- Public OSM routing and Overpass servers are shared; heavy demos can be slow. Swap in Google Routes/Places APIs with a billing-enabled key for production.
- Incident data starts empty. Seed 10-15 reports before your demo (see `PROMPT.md`).
- Photos are stored on local disk; use Cloud Storage in production.

## Files

`server.js` routes · `src/prompts.js` all system prompts · `src/ai.js` Gemini calls · `src/city.js` city data and risk scoring · `src/auth.js` · `src/db.js` · `public/index.html` UI

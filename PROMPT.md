# Master prompt (paste into Google AI Studio, Build mode, if the contest wants a prompt-built app)

Build a responsive web app called **CityPulse**, a smart city-exploration platform for Pune, India (make the city configurable).

**Users:** tourists and residents who want to find good places, understand local history, and avoid unsafe areas.

**Features**
1. Interactive map (Leaflet + OpenStreetMap) centred on the user's location, with a side panel of tabs: Explore, Safety, Compare, Route, Ask.
2. Explore: food, stays, sights, heritage sites from the OpenStreetMap Overpass API. Each place has a "Local story" button that calls Gemini with Google Search grounding and shows 120-160 words of verified history, one tradition and one visiting tip, plus source titles.
3. Safety: logged-in users submit a report using text (any language), a photo, or a voice note. Gemini (multimodal) transcribes and translates, classifies into one category (accident, crime, harassment, poor_lighting, flooding, traffic_jam, road_damage, garbage, crowd, noise, infrastructure, positive, other), rates severity 1-5 and credibility 0-1, writes a 140-character public summary with personal data removed, and rejects spam or abuse. Show reports as coloured circles on the map. Other users can confirm a report.
4. Compare: rank nearby places on safety, cleanliness, affordability and accessibility using user reviews, OSM tags and incidents within 300 m. Gemini explains best vs worst in under 110 words and flags low-confidence results.
5. Route: geocode a destination, fetch alternative routes, score each by nearby recent reports with a 7-day half-life, and show fastest vs safest with a short Gemini recommendation that factors in weather and time of day.
6. Ask: chat assistant grounded in live weather (Open-Meteo), nearby reports and nearby places. It replies in the user's language, under 130 words, and points to 112 for emergencies.
7. Weather strip with alerts for thunderstorms, heavy rain, heat and strong wind.

**Auth and data:** email and password sign-up, JWT sessions, SQLite tables for users, reports, confirmations, reviews.

**Quality bar:** works on mobile, keyboard accessible, clear error messages that say how to fix the problem, no API key in client code, rate limits on AI endpoints, treat all user text as untrusted data in prompts.

## Seed data for the demo (log in, then submit these near your demo location)
- "Streetlights not working on the lane behind the station, very dark after 8pm" (poor_lighting, 3)
- "Waterlogging knee-deep near the underpass, two-wheelers stalling" (flooding, 4)
- "Phone snatching reported twice this week near the market gate" (crime, 4)
- "Open manhole without cover next to the bus stop" (road_damage, 5)
- "Clean, well-lit promenade, lots of families in the evening" (positive, 1)

## Demo script (3 minutes)
1. Open the app; point out live weather alert. 2. Explore → Heritage → "Local story" with sources. 3. Record a Hindi/Marathi voice note + photo → show the AI category, severity and credibility. 4. Route to a landmark: show fastest vs safest and the AI advice. 5. Compare cafés and show an explanation. 6. Ask: "Cheap veg dinner nearby, safe to walk back at 10pm?"

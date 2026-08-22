# Location Tracker — backend (Vercel)

A small Express API that receives the daily route uploaded by the Android app,
built to deploy on Vercel with a Postgres database attached.

## Deploy it

1. **Push this `backend/` folder to a GitHub repo** (its own repo, or a subfolder of one —
   if it's a subfolder, you'll set the Root Directory in step 2).

2. **Import it in Vercel**: [vercel.com/new](https://vercel.com/new) → pick the repo →
   if `backend/` isn't the repo root, set **Root Directory** to `backend`. Deploy.

3. **Attach Postgres**: in the new project, go to the **Storage** tab → **Create Database**
   → Postgres (this provisions a Neon-backed Postgres database and automatically injects
   `DATABASE_URL` into your project's environment variables — you don't type this in
   yourself).

4. **Set your API key**: Project **Settings → Environment Variables** → add
   `API_KEY` with a long random value (e.g. output of `openssl rand -hex 24`).
   Apply it to Production (and Preview/Development if you want those to work too).

5. **Redeploy** (Deployments tab → ⋯ → Redeploy) so the new env vars take effect.

Your API is now live at `https://<your-project>.vercel.app`. The database tables are
created automatically the first time any endpoint runs — no separate migration step.

The mobile admin console is available at `https://<your-project>.vercel.app/admin/`.
Enter the device ID and the same API key configured in Vercel to view stored dates,
route points, map markers, and location names.

## Local development

```bash
npm install
npm install -g vercel        # if you don't have the CLI yet
vercel link                  # connect this folder to the Vercel project you created
vercel env pull .env         # pulls DATABASE_URL and API_KEY down into .env
npm start                    # runs on http://localhost:3000
```

(`vercel dev` also works and more closely mirrors the real serverless environment,
but plain `node server.js` is simpler for quick testing.)

## Endpoints

All endpoints require header `x-api-key: <your API_KEY>`.

### `POST /api/tracks`
Called once a day by the app.
```json
{
  "deviceId": "uuid-generated-by-the-app",
  "date": "2026-08-22",
  "points": [
    { "lat": 12.5, "lon": 75.0, "accuracy": 8.5, "timestamp": 1755840000000 }
  ]
}
```
Re-uploading the same `deviceId` + `date` replaces the previous points for that day
(safe to retry).

### `GET /api/tracks/:deviceId`
Lists every day that has a stored route for that device.

### `GET /api/tracks/:deviceId/:date`
Returns that day's route as GeoJSON (`LineString`) — drop straight into any map
library (Leaflet, Mapbox, Google Maps) to visualize the day's travel.

## Notes

- The database connection uses Neon's HTTP-based serverless driver
  (`@neondatabase/serverless`), which is what Vercel's Postgres integration runs on
  under the hood — it avoids the connection-pool exhaustion issues that a
  traditional TCP driver can hit across many short-lived serverless invocations.
- Each request is one self-contained call — there's no persistent server process,
  so nothing to keep running or restart.

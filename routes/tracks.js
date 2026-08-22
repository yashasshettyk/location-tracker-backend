const express = require('express');
const { getSql } = require('../db');

const router = express.Router();

// --- Auth middleware: every route here requires the shared API key ---
router.use((req, res, next) => {
  const key = req.header('x-api-key');
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Missing or invalid x-api-key header' });
  }
  next();
});

/**
 * POST /api/tracks
 * Body: {
 *   deviceId: string,
 *   date: "YYYY-MM-DD",
 *   points: [{ lat, lon, accuracy, timestamp }, ...]   // timestamp = epoch millis
 * }
 *
 * If a track already exists for this device+date, its points are replaced
 * (so the app can safely retry an upload without creating duplicates).
 */
router.post('/', async (req, res) => {
  const { deviceId, date, points } = req.body || {};

  if (!deviceId || typeof deviceId !== 'string') {
    return res.status(400).json({ error: 'deviceId is required' });
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date is required in YYYY-MM-DD format' });
  }
  if (!Array.isArray(points) || points.length === 0) {
    return res.status(400).json({ error: 'points must be a non-empty array' });
  }
  for (const p of points) {
    if (typeof p.lat !== 'number' || typeof p.lon !== 'number' || typeof p.timestamp !== 'number') {
      return res.status(400).json({ error: 'each point needs numeric lat, lon, timestamp' });
    }
  }

  try {
    const sql = await getSql();

    await sql.query(
      `INSERT INTO tracks (device_id, date) VALUES ($1, $2)
       ON CONFLICT (device_id, date) DO UPDATE SET created_at = now()`,
      [deviceId, date]
    );

    const trackRows = await sql.query(
      `SELECT id FROM tracks WHERE device_id = $1 AND date = $2`,
      [deviceId, date]
    );
    const trackId = trackRows[0].id;

    // Replace any previously-uploaded points for this day (handles retries cleanly)
    await sql.query(`DELETE FROM points WHERE track_id = $1`, [trackId]);

    // Single bulk insert instead of one round-trip per point
    const values = [];
    const placeholders = points
      .map((p, i) => {
        const base = i * 5;
        values.push(trackId, p.lat, p.lon, p.accuracy ?? null, p.timestamp);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
      })
      .join(', ');

    await sql.query(
      `INSERT INTO points (track_id, lat, lon, accuracy, timestamp) VALUES ${placeholders}`,
      values
    );

    res.status(201).json({ trackId, pointsStored: points.length });
  } catch (err) {
    console.error('[POST /api/tracks ERROR]', {
      message: err.message,
      code: err.code,
      sqlState: err.sqlState,
      hint: err.hint,
      stack: err.stack
    });
    res.status(500).json({ error: 'Failed to store track' });
  }
});

/**
 * GET /api/tracks/:deviceId
 * Lists all days that have a stored track for this device.
 */
router.get('/:deviceId', async (req, res) => {
  try {
    const sql = await getSql();
    const rows = await sql.query(
      `SELECT date, created_at,
              (SELECT COUNT(*) FROM points WHERE points.track_id = tracks.id) AS "pointCount"
       FROM tracks WHERE device_id = $1 ORDER BY date DESC`,
      [req.params.deviceId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tracks' });
  }
});

/**
 * GET /api/tracks/:deviceId/:date
 * Returns one day's route as GeoJSON (easy to drop straight into a map).
 */
router.get('/:deviceId/:date', async (req, res) => {
  try {
    const sql = await getSql();

    const trackRows = await sql.query(
      `SELECT id, created_at FROM tracks WHERE device_id = $1 AND date = $2`,
      [req.params.deviceId, req.params.date]
    );

    if (trackRows.length === 0) {
      return res.status(404).json({ error: 'No track for that device/date' });
    }
    const track = trackRows[0];

    const points = await sql.query(
      `SELECT lat, lon, accuracy, timestamp FROM points WHERE track_id = $1 ORDER BY timestamp ASC`,
      [track.id]
    );

    res.json({
      type: 'Feature',
      properties: {
        deviceId: req.params.deviceId,
        date: req.params.date,
        uploadedAt: track.created_at,
        pointCount: points.length,
      },
      geometry: {
        type: 'LineString',
        coordinates: points.map((p) => [p.lon, p.lat]), // GeoJSON is [lon, lat]
      },
      points, // raw points too, in case you want accuracy/timestamp per point
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch track' });
  }
});

module.exports = router;

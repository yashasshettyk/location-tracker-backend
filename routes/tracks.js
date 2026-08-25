const express = require('express');
const { getSql } = require('../db');
const { sendLocationRequest } = require('../firebase');

const router = express.Router();

// --- Auth middleware: every route here requires the shared API key ---
router.use((req, res, next) => {
  const key = req.header('x-api-key');
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Missing or invalid x-api-key header' });
  }
  next();
});

router.get('/devices', async (req, res) => {
  try {
    const sql = await getSql();
    const rows = await sql.query(
      `SELECT devices.device_id AS "deviceId",
              devices.last_seen AS "lastSeen",
              COALESCE(settings.interval_minutes, 15) AS "intervalMinutes",
              (SELECT COUNT(*) FROM tracks WHERE tracks.device_id = devices.device_id) AS "daysTracked"
       FROM (
         SELECT device_id, MAX(last_seen) AS last_seen
         FROM (
           SELECT device_id, MAX(created_at) AS last_seen FROM tracks GROUP BY device_id
           UNION ALL
           SELECT device_id, MAX(updated_at) AS last_seen FROM device_settings GROUP BY device_id
         ) activity
         GROUP BY device_id
       ) devices
       LEFT JOIN device_settings settings ON settings.device_id = devices.device_id
       ORDER BY devices.last_seen DESC NULLS LAST, devices.device_id ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET devices ERROR]', err);
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
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

    // De-duplicate the incoming batch by timestamp: a single INSERT ... ON CONFLICT can't
    // touch the same (track_id, timestamp) twice, and Postgres rejects it if it does.
    const uniquePoints = Array.from(
      new Map(points.map((p) => [p.timestamp, p])).values()
    );

    // MERGE the points into the day instead of replacing it. The unique index on
    // (track_id, timestamp) makes this idempotent: re-uploading an existing fix updates it
    // in place, while new fixes are added. A partial upload therefore extends the day's
    // history rather than wiping it.
    const values = [];
    const placeholders = uniquePoints
      .map((p, i) => {
        const base = i * 5;
        values.push(trackId, p.lat, p.lon, p.accuracy ?? null, p.timestamp);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
      })
      .join(', ');

    await sql.query(
      `INSERT INTO points (track_id, lat, lon, accuracy, timestamp) VALUES ${placeholders}
       ON CONFLICT (track_id, timestamp) DO UPDATE
         SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, accuracy = EXCLUDED.accuracy`,
      values
    );

    res.status(201).json({ trackId, pointsStored: uniquePoints.length });
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

router.get('/:deviceId/settings', async (req, res) => {
  try {
    const sql = await getSql();
    const rows = await sql.query(
      `SELECT device_id AS "deviceId", interval_minutes AS "intervalMinutes",
              location_request_at AS "locationRequestAt", updated_at AS "updatedAt"
       FROM device_settings WHERE device_id = $1`,
      [req.params.deviceId]
    );
    res.json(rows[0] || {
      deviceId: req.params.deviceId,
      intervalMinutes: 15,
      locationRequestAt: null,
      updatedAt: null
    });
  } catch (err) {
    console.error('[GET settings ERROR]', err);
    res.status(500).json({ error: 'Failed to fetch device settings' });
  }
});

router.put('/:deviceId/settings', async (req, res) => {
  const intervalMinutes = Number(req.body?.intervalMinutes);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
    return res.status(400).json({ error: 'intervalMinutes must be a whole number from 1 to 1440' });
  }
  try {
    const sql = await getSql();
    const rows = await sql.query(
      `INSERT INTO device_settings (device_id, interval_minutes, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (device_id) DO UPDATE SET interval_minutes = EXCLUDED.interval_minutes,
                                             updated_at = now()
       RETURNING device_id AS "deviceId", interval_minutes AS "intervalMinutes",
                 location_request_at AS "locationRequestAt", updated_at AS "updatedAt"`,
      [req.params.deviceId, intervalMinutes]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[PUT settings ERROR]', err);
    res.status(500).json({ error: 'Failed to save device settings' });
  }
});

router.put('/:deviceId/fcm-token', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token) return res.status(400).json({ error: 'token is required' });
  try {
    const sql = await getSql();
    await sql.query(
      `INSERT INTO device_settings (device_id, fcm_token, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (device_id) DO UPDATE SET fcm_token = EXCLUDED.fcm_token, updated_at = now()`,
      [req.params.deviceId, token]
    );
    res.status(204).send();
  } catch (err) {
    console.error('[PUT FCM token ERROR]', err);
    res.status(500).json({ error: 'Failed to register device notifications' });
  }
});

router.post('/:deviceId/location-request', async (req, res) => {
  try {
    const sql = await getSql();
    const rows = await sql.query(
      `INSERT INTO device_settings (device_id, location_request_at, updated_at)
       VALUES ($1, now(), now())
       ON CONFLICT (device_id) DO UPDATE SET location_request_at = now(), updated_at = now()
       RETURNING location_request_at AS "locationRequestAt", fcm_token AS "fcmToken"`,
      [req.params.deviceId]
    );
    if (!rows[0].fcmToken) return res.status(409).json({ error: 'Device has not registered for push notifications' });
    await sendLocationRequest(rows[0].fcmToken, req.params.deviceId);
    res.status(202).json({ requestedAt: rows[0].locationRequestAt });
  } catch (err) {
    console.error('[POST location request ERROR]', err);
    res.status(500).json({ error: 'Failed to request current location' });
  }
});

router.get('/:deviceId/latest', async (req, res) => {
  try {
    const sql = await getSql();
    const rows = await sql.query(
      `SELECT p.lat, p.lon, p.accuracy, p.timestamp, t.date
       FROM points p JOIN tracks t ON t.id = p.track_id
       WHERE t.device_id = $1 ORDER BY p.timestamp DESC LIMIT 1`,
      [req.params.deviceId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No location received yet' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[GET latest location ERROR]', err);
    res.status(500).json({ error: 'Failed to fetch latest location' });
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
      `SELECT date, created_at, to_char(created_at, 'YYYY-MM-DD FMHH12:MI AM') AS "createdAt12",
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
      `SELECT id, created_at, to_char(created_at, 'YYYY-MM-DD FMHH12:MI AM') AS "createdAt12"
       FROM tracks WHERE device_id = $1 AND date = $2`,
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
        uploadedAt12: track.createdAt12,
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

/**
 * DELETE /api/tracks/:deviceId/:date/points/:timestamp
 * Deletes a single point (identified by its epoch-millis timestamp) from one day's track.
 */
router.delete('/:deviceId/:date/points/:timestamp', async (req, res) => {
  const timestamp = Number(req.params.timestamp);
  if (!Number.isFinite(timestamp)) {
    return res.status(400).json({ error: 'timestamp must be a number (epoch millis)' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
    return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });
  }
  try {
    const sql = await getSql();
    const rows = await sql.query(
      `DELETE FROM points
       USING tracks
       WHERE points.track_id = tracks.id
         AND tracks.device_id = $1 AND tracks.date = $2
         AND points.timestamp = $3
       RETURNING points.id`,
      [req.params.deviceId, req.params.date, timestamp]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'No point with that timestamp for this device/date' });
    }
    res.json({ deviceId: req.params.deviceId, date: req.params.date, timestamp, pointsDeleted: rows.length });
  } catch (err) {
    console.error('[DELETE point ERROR]', err);
    res.status(500).json({ error: 'Failed to delete point' });
  }
});

/**
 * DELETE /api/tracks/:deviceId/:date
 * Deletes one day's track for a device. Its points are removed automatically
 * (points.track_id has ON DELETE CASCADE).
 */
router.delete('/:deviceId/:date', async (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
    return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });
  }
  try {
    const sql = await getSql();
    const rows = await sql.query(
      `DELETE FROM tracks WHERE device_id = $1 AND date = $2 RETURNING id`,
      [req.params.deviceId, req.params.date]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'No track for that device/date' });
    }
    res.json({ deviceId: req.params.deviceId, date: req.params.date, deleted: true });
  } catch (err) {
    console.error('[DELETE track ERROR]', err);
    res.status(500).json({ error: 'Failed to delete track' });
  }
});

/**
 * DELETE /api/tracks/:deviceId
 * Removes a device completely: all of its tracks (points cascade) and its
 * saved settings / notification token.
 */
router.delete('/:deviceId', async (req, res) => {
  try {
    const sql = await getSql();
    const tracksDeleted = await sql.query(
      `DELETE FROM tracks WHERE device_id = $1 RETURNING id`,
      [req.params.deviceId]
    );
    const settingsDeleted = await sql.query(
      `DELETE FROM device_settings WHERE device_id = $1 RETURNING device_id`,
      [req.params.deviceId]
    );
    if (!tracksDeleted.length && !settingsDeleted.length) {
      return res.status(404).json({ error: 'No such device' });
    }
    res.json({ deviceId: req.params.deviceId, tracksDeleted: tracksDeleted.length });
  } catch (err) {
    console.error('[DELETE device ERROR]', err);
    res.status(500).json({ error: 'Failed to delete device' });
  }
});

module.exports = router;

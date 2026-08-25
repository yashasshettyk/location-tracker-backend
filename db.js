const { neon } = require('@neondatabase/serverless');

// Vercel's Postgres integration (backed by Neon) injects DATABASE_URL automatically once
// you attach a database to the project in the dashboard's Storage tab. POSTGRES_URL is
// the older name for the same value, kept here for compatibility.
const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

// sql is an HTTP-based query function - no persistent connection to open/close per
// request, which fits serverless functions well (each invocation is short-lived).
const sql = connectionString ? neon(connectionString) : null;
const query = sql ? (text, params) => sql(text, params) : null;

let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;

  await query(`
    CREATE TABLE IF NOT EXISTS tracks (
      id SERIAL PRIMARY KEY,
      device_id TEXT NOT NULL,
      date TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(device_id, date)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS points (
      id SERIAL PRIMARY KEY,
      track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      lat DOUBLE PRECISION NOT NULL,
      lon DOUBLE PRECISION NOT NULL,
      accuracy DOUBLE PRECISION,
      timestamp BIGINT NOT NULL
    );
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_points_track_id ON points(track_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tracks_device_date ON tracks(device_id, date);`);

  // Enforce one row per (track, timestamp). This lets uploads MERGE into a day instead of
  // replacing it wholesale, so a partial upload (a single on-demand fix, or the first upload
  // right after a reinstall when the phone's local copy is sparse) can't wipe points the
  // server already stored. Remove any pre-existing duplicates first so the index can be built.
  await query(`
    DELETE FROM points a USING points b
    WHERE a.id > b.id AND a.track_id = b.track_id AND a.timestamp = b.timestamp;
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_points_track_timestamp
    ON points(track_id, timestamp);
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS device_settings (
      device_id TEXT PRIMARY KEY,
      interval_minutes INTEGER NOT NULL DEFAULT 15,
      fcm_token TEXT,
      location_request_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`ALTER TABLE device_settings ADD COLUMN IF NOT EXISTS fcm_token TEXT;`);

  schemaReady = true;
}

/** Returns the query function, guaranteeing the schema exists first. */
async function getSql() {
  if (!sql) {
    throw new Error(
      'DATABASE_URL is not set. In the Vercel dashboard, open your project > Storage, ' +
      'attach a Postgres database, then redeploy.'
    );
  }
  await ensureSchema();
  return { query };
}

module.exports = { getSql };

// Only used for local development (`node server.js`). On Vercel, api/index.js is the
// entry point instead and this file is never invoked.
const app = require('./app');

if (!process.env.API_KEY) {
  console.error('ERROR: API_KEY is not set. Run `vercel env pull .env` (or set it manually) before starting.');
  process.exit(1);
}
if (!process.env.POSTGRES_URL) {
  console.error('ERROR: POSTGRES_URL is not set. Run `vercel env pull .env` after attaching Postgres in the Vercel dashboard.');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Location tracker backend listening on port ${PORT} (local dev mode)`);
});

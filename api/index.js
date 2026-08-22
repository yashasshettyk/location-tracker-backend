// Vercel treats every file in /api as its own serverless function. Exporting the whole
// Express app here (paired with the rewrite rule in vercel.json) lets one function handle
// every route, so the Express routing in app.js/routes/ keeps working unchanged.
module.exports = require('../app');

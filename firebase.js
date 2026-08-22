const fs = require('fs');
const path = require('path');
const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

function getCredential() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) return cert(JSON.parse(raw));

  const file = path.join(__dirname, 'firebase-service-account.json');
  if (fs.existsSync(file)) return cert(require(file));
  throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured');
}

function messaging() {
  const app = getApps()[0] || initializeApp({ credential: getCredential() });
  return getMessaging(app);
}

async function sendLocationRequest(token, deviceId) {
  return messaging().send({
    token,
    data: { type: 'location_request', deviceId },
    android: { priority: 'high' }
  });
}

module.exports = { sendLocationRequest };
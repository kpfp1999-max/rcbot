// Load .env only when NOT in production
const isProd = process.env.NODE_ENV === 'production';
if (!isProd) {
  try {
    require('dotenv').config();
  } catch (_) {}
}

// Small helper to make sure required env vars exist
function requireEnv(keys) {
  const missing = keys.filter(k => !process.env[k] || process.env[k].trim() === '');
  if (missing.length) throw new Error('Missing environment variables: ' + missing.join(', '));
}

// List everything your bot needs
requireEnv([
  'DISCORD_TOKEN',
  'SPREADSHEET_ID',
  'GOOGLE_CLIENT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
  'ROBLOX_COOKIE',
]);

// Export them for the rest of the app
module.exports = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  SPREADSHEET_ID: process.env.SPREADSHEET_ID,
  GOOGLE_CLIENT_EMAIL: process.env.GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY,
  ROBLOX_COOKIE: process.env.ROBLOX_COOKIE,
  NODE_ENV: process.env.NODE_ENV || 'development',
};

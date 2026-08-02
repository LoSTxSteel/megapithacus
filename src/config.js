const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function loadEnv() {
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '.env'),
    path.join(__dirname, '..', '.env'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      dotenv.config({ path: file });
      return file;
    }
  }
  dotenv.config();
  return null;
}

loadEnv();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

module.exports = {
  token: () => required('DISCORD_TOKEN'),
  clientId: () => required('DISCORD_CLIENT_ID'),
  guildId: process.env.DISCORD_GUILD_ID || null,
  /** Optional developer Discord for deploy/update notifications */
  developerGuildId: process.env.DEVELOPER_GUILD_ID || null,
  developerChannelId: process.env.DEVELOPER_CHANNEL_ID || null,
  brand: {
    name: 'Megapithacus',
    color: 0xe74c3c,
    accent: 0xe74c3c,
  },
  platform: {
    game: 'ARK: Survival Evolved',
    store: 'Microsoft Store',
    host: 'Nitrado',
  },
  /** OpenXBL key for Xbox gamerscore lookups (optional; feature fail-opens without it) */
  openxblApiKey: process.env.OPENXBL_API_KEY || process.env.XBOX_API_KEY || null,
};

require('dotenv').config();

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
    color: 0x2ecc71,
    accent: 0xe67e22,
  },
  platform: {
    game: 'ARK: Survival Evolved',
    store: 'Microsoft Store',
    host: 'Nitrado',
  },
};

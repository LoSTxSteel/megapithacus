const { ActivityType } = require('discord.js');
const { ensureBrandLogo } = require('./brandLogo');

const ROTATE_MS = 15 * 1000;

let timer = null;
let index = 0;

/** Discord activities don't support markdown; underline digits with U+0332. */
function underlineNumbers(text) {
  return String(text).replace(/\d/g, (digit) => `${digit}\u0332`);
}

function collectStats(client) {
  const guilds = client?.guilds?.cache;
  let discordServers = 0;
  let members = 0;

  if (guilds?.size) {
    discordServers = guilds.size;
    for (const guild of guilds.values()) {
      members += guild.memberCount || 0;
    }
  }

  return { discordServers, members };
}

function statusLines(stats) {
  const memberLabel = `${stats.members} member${stats.members === 1 ? '' : 's'}`;
  const serverLabel = `${stats.discordServers} server${stats.discordServers === 1 ? '' : 's'}`;
  return [
    {
      name: underlineNumbers(`${memberLabel} in ${serverLabel}`),
      type: ActivityType.Watching,
    },
    {
      name: 'ASE Manager @ /help',
      type: ActivityType.Playing,
    },
  ];
}

async function tick(client) {
  if (!client?.user) return;
  try {
    const lines = statusLines(collectStats(client));
    const next = lines[index % lines.length];
    index += 1;
    await client.user.setActivity(next.name, { type: next.type });
  } catch (error) {
    console.warn('Status rotation failed:', error.message);
  }
}

function startStatusRotation(client) {
  if (timer) return;
  ensureBrandLogo(client).catch((error) => {
    console.warn('Brand logo setup failed:', error.message);
  });
  tick(client);
  timer = setInterval(() => {
    tick(client);
  }, ROTATE_MS);
  console.log('Status rotation started (every 15s)');
}

module.exports = {
  startStatusRotation,
  collectStats,
};

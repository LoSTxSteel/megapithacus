const { ActivityType } = require('discord.js');

const ROTATE_MS = 15 * 1000;

let timer = null;
let index = 0;

/** Discord activities don't support markdown; use Mathematical Bold Unicode. */
function toBold(text) {
  return String(text).replace(/[A-Za-z0-9]/g, (ch) => {
    const code = ch.codePointAt(0);
    if (code >= 48 && code <= 57) return String.fromCodePoint(0x1d7ce + (code - 48)); // 0-9
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1d400 + (code - 65)); // A-Z
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1d41a + (code - 97)); // a-z
    return ch;
  });
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
      name: toBold(`${memberLabel} in ${serverLabel}`),
      type: ActivityType.Watching,
    },
    {
      name: toBold('ASE Manager @ /help'),
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

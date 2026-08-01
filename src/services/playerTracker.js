const { getGuild, listGuildIds } = require('./storage');
const { listPlayers, getGameserver, tokenForServer, extractMapName } = require('./nitrado');
const {
  upsertPlayer,
  markOfflineExcept,
  normalizeOnlinePlayer,
  profileKey,
} = require('./playerDb');

const INTERVAL_MS = 60 * 1000;
let timer = null;

// serviceId -> Set of profile keys last seen online
const previousOnline = new Map();

async function scanGuild(guildId) {
  const guild = getGuild(guildId);
  if (!(guild.nitradoAccounts || []).length || !(guild.servers || []).length) {
    return;
  }

  for (const server of guild.servers) {
    const token = tokenForServer(server, guild);
    if (!token) continue;

    const serviceId = String(server.serviceId);
    let mapName = server.name;
    try {
      const gs = await getGameserver(serviceId, token);
      mapName = extractMapName(gs, server.name);
    } catch {
      // keep fallback map name
    }

    const players = await listPlayers(serviceId, token);
    if (!Array.isArray(players)) continue;

    const onlineKeys = new Set();
    const prevKey = `${guildId}:${serviceId}`;
    const prev = previousOnline.get(prevKey) || new Set();

    for (const raw of players) {
      const normalized = normalizeOnlinePlayer(raw, {
        map: mapName,
        serviceId,
      });
      if (!normalized.gamertag && !normalized.characterName && !normalized.specimenImplant) {
        continue;
      }

      const key = profileKey(normalized);
      if (key) onlineKeys.add(key);

      const isJoin = key && !prev.has(key);
      upsertPlayer(guildId, normalized, { joined: isJoin });
    }

    markOfflineExcept(guildId, onlineKeys, serviceId);
    previousOnline.set(prevKey, onlineKeys);
  }
}

async function scanAll() {
  for (const guildId of listGuildIds()) {
    try {
      await scanGuild(guildId);
    } catch (error) {
      console.warn(`Player tracker error (${guildId}):`, error.message);
    }
  }
}

function startPlayerTracker() {
  if (timer) clearInterval(timer);

  setTimeout(() => {
    scanAll().catch((err) => console.warn('Player tracker startup:', err.message));
  }, 25_000);

  timer = setInterval(() => {
    scanAll().catch((err) => console.warn('Player tracker interval:', err.message));
  }, INTERVAL_MS);

  console.log('Player tracker started (poll every 60s · join logging + search DB)');
}

module.exports = {
  startPlayerTracker,
  scanGuild,
  scanAll,
  INTERVAL_MS,
};

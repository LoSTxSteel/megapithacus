const { getGuild, listGuildIds } = require('./storage');
const { listPlayers, getGameserver, tokenForServer, extractMapName } = require('./nitrado');
const {
  upsertPlayer,
  markOfflineExcept,
  normalizeOnlinePlayer,
  profileKey,
} = require('./playerDb');
const { postJoinLeave } = require('./joinLeaveLog');
const { ensureMapForums, isFeatureEnabled, isFeatureConfigured } = require('./featureSetup');
const { handleGamerscoreJoin } = require('./gamerscoreDetection');

const INTERVAL_MS = 60 * 1000;
let timer = null;

// serviceId -> Set of profile keys last seen online
const previousOnline = new Map();

async function scanGuild(client, guildId) {
  const guild = getGuild(guildId);
  if (!(guild.nitradoAccounts || []).length || !(guild.servers || []).length) {
    return;
  }

  let discordGuild = null;
  const wantsJoinLeave =
    isFeatureEnabled(guild, 'joinLeaveLogs') && isFeatureConfigured(guild, 'joinLeaveLogs');
  const wantsGamerscore =
    isFeatureEnabled(guild, 'gamerscoreDetection') &&
    isFeatureConfigured(guild, 'gamerscoreDetection');
  if ((wantsJoinLeave || wantsGamerscore) && client) {
    discordGuild = await client.guilds.fetch(guildId).catch(() => null);
    if (discordGuild && wantsJoinLeave) {
      await ensureMapForums(discordGuild, getGuild(guildId)).catch(() => null);
    }
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
    const isBootstrap = !previousOnline.has(prevKey);
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

      const isJoin = !isBootstrap && key && !prev.has(key);
      const profile = upsertPlayer(
        guildId,
        { ...normalized, serverName: server.name || mapName },
        { joined: isJoin }
      );

      if (isJoin && discordGuild) {
        if (wantsJoinLeave) {
          await postJoinLeave(discordGuild, guildId, serviceId, {
            type: 'join',
            profile,
            mapName,
            serverName: server.name,
          }).catch((err) => console.warn('Join log failed:', err.message));
        }
        if (wantsGamerscore) {
          await handleGamerscoreJoin(discordGuild, guildId, {
            profile,
            mapName,
            serverName: server.name,
            serviceId,
          }).catch((err) =>
            console.warn('Gamerscore detection failed:', err.message)
          );
        }
      }
    }

    const left = markOfflineExcept(guildId, onlineKeys, serviceId);
    if (!isBootstrap && discordGuild && wantsJoinLeave) {
      for (const profile of left) {
        await postJoinLeave(discordGuild, guildId, serviceId, {
          type: 'leave',
          profile,
          mapName: profile.map || mapName,
          serverName: server.name,
        }).catch((err) => console.warn('Leave log failed:', err.message));
      }
    }

    previousOnline.set(prevKey, onlineKeys);
  }
}

async function scanAll(client) {
  for (const guildId of listGuildIds()) {
    try {
      await scanGuild(client, guildId);
    } catch (error) {
      console.warn(`Player tracker error (${guildId}):`, error.message);
    }
  }
}

function startPlayerTracker(client) {
  if (timer) clearInterval(timer);

  setTimeout(() => {
    scanAll(client).catch((err) => console.warn('Player tracker startup:', err.message));
  }, 25_000);

  timer = setInterval(() => {
    scanAll(client).catch((err) => console.warn('Player tracker interval:', err.message));
  }, INTERVAL_MS);

  console.log('Player tracker started (poll every 60s · joins/leaves + search DB)');
}

module.exports = {
  startPlayerTracker,
  scanGuild,
  scanAll,
  INTERVAL_MS,
};

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

const INTERVAL_MS = 3 * 60 * 1000;
let timer = null;

// serviceId -> Set of profile keys last seen online
const previousOnline = new Map();

/** Warn once per guild/reason (avoid interval spam). */
const skipWarned = new Set();

function warnSkipOnce(guildId, reason) {
  const key = `${guildId}:${reason}`;
  if (skipWarned.has(key)) return;
  skipWarned.add(key);
  console.warn(`[playerTracker] skip guild=${guildId}: ${reason}`);
}

async function scanServer(client, guildId, guild, server, discordGuild, wantsJoinLeave, wantsGamerscore) {
  const token = tokenForServer(server, guild);
  if (!token) return;

  const serviceId = String(server.serviceId);
  let mapName = server.name;
  try {
    const gs = await getGameserver(serviceId, token);
    mapName = extractMapName(gs, server.name);
  } catch {
    // keep fallback map name
  }

  const players = await listPlayers(serviceId, token);
  if (!Array.isArray(players)) {
    warnSkipOnce(
      guildId,
      `Nitrado players list failed for serviceId=${serviceId} (token/API)`
    );
    return;
  }

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

    if (isJoin && discordGuild && wantsJoinLeave) {
      const posted = await postJoinLeave(discordGuild, guildId, serviceId, {
        type: 'join',
        profile,
        mapName,
        serverName: server.name,
      }).catch((err) => {
        console.warn(`[playerTracker] join log failed: ${err.message}`);
        return { ok: false, reason: 'error' };
      });
      if (posted && !posted.ok && posted.reason === 'no_thread') {
        warnSkipOnce(
          guildId,
          `joinLeaveLogs missing map thread for serviceId=${serviceId} — Sync servers / Feature Setup`
        );
      }
    }

    // Gamerscore: true joins + bootstrap snapshot (bot restart must still kick
    // low-score players already online). Never await — OpenXBL can stall polls.
    const shouldCheckGamerscore =
      wantsGamerscore &&
      discordGuild &&
      key &&
      (isJoin || isBootstrap);
    if (shouldCheckGamerscore) {
      console.log(
        `[playerTracker] gamerscore queue guild=${guildId} ` +
          `gt=${profile.gamertag || '(none)'} join=${isJoin} bootstrap=${isBootstrap} ` +
          `nitradoPlayerId=${profile.nitradoPlayerId || '(none)'} serviceId=${serviceId}`
      );
      void handleGamerscoreJoin(discordGuild, guildId, {
        profile,
        mapName,
        serverName: server.name,
        serviceId,
      }).catch((err) =>
        console.warn(
          `[playerTracker] gamerscore detection failed: ${err?.stack || err.message || err}`
        )
      );
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
      }).catch((err) => console.warn(`[playerTracker] leave log failed: ${err.message}`));
    }
  }

  previousOnline.set(prevKey, onlineKeys);
}

async function scanGuild(client, guildId) {
  const guild = getGuild(guildId);
  if (!(guild.nitradoAccounts || []).length || !(guild.servers || []).length) {
    return;
  }

  let discordGuild = null;
  const joinLeaveEnabled = isFeatureEnabled(guild, 'joinLeaveLogs');
  const wantsJoinLeave =
    joinLeaveEnabled && isFeatureConfigured(guild, 'joinLeaveLogs');
  const wantsGamerscore =
    isFeatureEnabled(guild, 'gamerscoreDetection') &&
    isFeatureConfigured(guild, 'gamerscoreDetection');

  if (joinLeaveEnabled && !wantsJoinLeave) {
    warnSkipOnce(
      guildId,
      'joinLeaveLogs enabled but not configured (missing forum/threads — run Feature Setup)'
    );
  }

  const gamerscoreEnabled = isFeatureEnabled(guild, 'gamerscoreDetection');
  if (gamerscoreEnabled && !wantsGamerscore) {
    warnSkipOnce(
      guildId,
      'gamerscoreDetection enabled but not configured (missing #gamerscore-detection — run Feature Setup)'
    );
  }

  if ((wantsJoinLeave || wantsGamerscore) && client) {
    discordGuild = await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) {
      warnSkipOnce(guildId, 'Discord guild not reachable from this bot');
    } else if (wantsJoinLeave) {
      await ensureMapForums(discordGuild, getGuild(guildId)).catch((err) => {
        console.warn(
          `[playerTracker] ensureMapForums failed guild=${guildId}: ${err.message}`
        );
      });
    }
  }

  for (const server of guild.servers) {
    try {
      await scanServer(
        client,
        guildId,
        guild,
        server,
        discordGuild,
        wantsJoinLeave,
        wantsGamerscore
      );
    } catch (error) {
      console.warn(
        `[playerTracker] scan failed guild=${guildId} serviceId=${server.serviceId}: ${error.message}`
      );
    }
  }
}

async function scanAll(client) {
  for (const guildId of listGuildIds()) {
    try {
      await scanGuild(client, guildId);
    } catch (error) {
      console.warn(`[playerTracker] error guild=${guildId}: ${error.message}`);
    }
  }
}

function startPlayerTracker(client) {
  if (timer) clearInterval(timer);

  setTimeout(() => {
    scanAll(client).catch((err) =>
      console.warn('[playerTracker] startup:', err.message)
    );
  }, 25_000);

  timer = setInterval(() => {
    scanAll(client).catch((err) =>
      console.warn('[playerTracker] interval:', err.message)
    );
  }, INTERVAL_MS);

  console.log('[scheduler] playerTracker started (3m)');
}

module.exports = {
  startPlayerTracker,
  scanGuild,
  scanAll,
  INTERVAL_MS,
};

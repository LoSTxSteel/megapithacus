const { getGuild, listGuildIds } = require('./storage');
const {
  listPlayers,
  getGameserverCached,
  tokenForServer,
  extractMapName,
  isGuildHeavyPollPaused,
  getGuildClusterSnapshot,
} = require('./nitrado');
const {
  upsertPlayer,
  markOfflineExcept,
  normalizeOnlinePlayer,
  profileKey,
} = require('./playerDb');
const { postJoinLeave } = require('./joinLeaveLog');
const { ensureMapForums, isFeatureEnabled, isFeatureConfigured } = require('./featureSetup');
const {
  handleGamerscoreJoin,
  isGamerscoreChecked,
} = require('./gamerscoreDetection');
const {
  handleSpoofJoin,
  isSpoofChecked,
} = require('./spoofDetection');

/** Join/leave poll — games/players is lighter than file_server; keep responsive. */
const INTERVAL_MS = 4 * 60 * 1000;
/** Stagger between servers so games/players is not burst (5–10s). */
const SERVICE_STAGGER_MS = 8000;
let timer = null;

// serviceId -> Set of profile keys last seen online
const previousOnline = new Map();

/** Warn once per guild/reason (avoid interval spam). */
const skipWarned = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function warnSkipOnce(guildId, reason) {
  const key = `${guildId}:${reason}`;
  if (skipWarned.has(key)) return;
  skipWarned.add(key);
  console.warn(`[playerTracker] skip guild=${guildId}: ${reason}`);
}

async function scanServer(
  client,
  guildId,
  guild,
  server,
  discordGuild,
  wantsJoinLeave,
  wantsGamerscore,
  wantsSpoof
) {
  const token = tokenForServer(server, guild);
  if (!token) return;

  const serviceId = String(server.serviceId);
  let mapName = server.name;
  try {
    // Shared with queryService / pop snapshot (gameserver + players caches).
    const gs = await getGameserverCached(serviceId, token);
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
  let joinCount = 0;
  let leaveCount = 0;

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
      if (posted?.ok) joinCount += 1;
      if (posted && !posted.ok && posted.reason === 'no_thread') {
        warnSkipOnce(
          guildId,
          `joinLeaveLogs missing map thread for serviceId=${serviceId} — Sync servers / Feature Setup`
        );
      }
    }

    // Gamerscore: true joins + bootstrap for never-checked players only.
    // Once checked (pass/fail/unverifiable), never check again — even on rejoin.
    const shouldCheckGamerscore =
      wantsGamerscore &&
      discordGuild &&
      key &&
      (isJoin || isBootstrap) &&
      !isGamerscoreChecked(guildId, profile);
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

    // Spoof: joins + bootstrap; skip if already checked for this displayed name.
    const displayedForSpoof = profile.gamertag
      ? String(profile.gamertag).trim()
      : '';
    const shouldCheckSpoof =
      wantsSpoof &&
      discordGuild &&
      key &&
      displayedForSpoof &&
      (isJoin || isBootstrap) &&
      !isSpoofChecked(guildId, profile, displayedForSpoof);
    if (shouldCheckSpoof) {
      console.log(
        `[playerTracker] spoof queue guild=${guildId} ` +
          `gt=${displayedForSpoof} join=${isJoin} bootstrap=${isBootstrap} ` +
          `platformId=${profile.platformId || '(none)'} serviceId=${serviceId}`
      );
      void handleSpoofJoin(discordGuild, guildId, {
        profile,
        mapName,
        serverName: server.name,
        serviceId,
      }).catch((err) =>
        console.warn(
          `[playerTracker] spoof detection failed: ${err?.stack || err.message || err}`
        )
      );
    }
  }

  const left = markOfflineExcept(guildId, onlineKeys, serviceId);
  if (!isBootstrap && discordGuild && wantsJoinLeave) {
    for (const profile of left) {
      const posted = await postJoinLeave(discordGuild, guildId, serviceId, {
        type: 'leave',
        profile,
        mapName: profile.map || mapName,
        serverName: server.name,
      }).catch((err) => {
        console.warn(`[playerTracker] leave log failed: ${err.message}`);
        return { ok: false };
      });
      if (posted?.ok) leaveCount += 1;
    }
  }

  previousOnline.set(prevKey, onlineKeys);
  console.log(
    `[playerTracker] scan serviceId=${serviceId} online=${onlineKeys.size}` +
      ` bootstrap=${isBootstrap} joinsPosted=${joinCount} leavesPosted=${leaveCount}`
  );
}

async function scanGuild(client, guildId) {
  const guild = getGuild(guildId);
  if (!(guild.nitradoAccounts || []).length || !(guild.servers || []).length) {
    return;
  }

  // Only games/players cooldown pauses tracker — file_server 429 must not.
  if (isGuildHeavyPollPaused(guild)) {
    if (!skipWarned.has(`${guildId}:rate_limited`)) {
      skipWarned.add(`${guildId}:rate_limited`);
      console.warn(
        `[playerTracker] games/players cooldown guild=${guildId} — skipping scan`
      );
    }
    return;
  }
  skipWarned.delete(`${guildId}:rate_limited`);

  // Warm shared cluster snapshot so listPlayers/getGameserver hit cache.
  try {
    await getGuildClusterSnapshot(guild, guildId);
  } catch (error) {
    console.warn(
      `[playerTracker] cluster snapshot failed guild=${guildId}: ${error.message}`
    );
  }

  let discordGuild = null;
  const joinLeaveEnabled = isFeatureEnabled(guild, 'joinLeaveLogs');
  const wantsJoinLeave =
    joinLeaveEnabled && isFeatureConfigured(guild, 'joinLeaveLogs');
  const wantsGamerscore =
    isFeatureEnabled(guild, 'gamerscoreDetection') &&
    isFeatureConfigured(guild, 'gamerscoreDetection');
  const wantsSpoof =
    isFeatureEnabled(guild, 'spoofDetection') &&
    isFeatureConfigured(guild, 'spoofDetection');

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

  const spoofEnabled = isFeatureEnabled(guild, 'spoofDetection');
  if (spoofEnabled && !wantsSpoof) {
    warnSkipOnce(
      guildId,
      'spoofDetection enabled but not configured (missing #spoof-detection — run Feature Setup)'
    );
  }

  if ((wantsJoinLeave || wantsGamerscore || wantsSpoof) && client) {
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

  const servers = guild.servers || [];
  for (let i = 0; i < servers.length; i += 1) {
    if (i > 0) await sleep(SERVICE_STAGGER_MS);
    const server = servers[i];
    try {
      await scanServer(
        client,
        guildId,
        guild,
        server,
        discordGuild,
        wantsJoinLeave,
        wantsGamerscore,
        wantsSpoof
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

  console.log(
    `[scheduler] playerTracker started (${Math.round(INTERVAL_MS / 60000)}m)`
  );
}

module.exports = {
  startPlayerTracker,
  scanGuild,
  scanAll,
  INTERVAL_MS,
};

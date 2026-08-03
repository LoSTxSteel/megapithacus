const {
  listPlayers,
  getGameserverCached,
  tokenForServer,
  extractMapName,
  isGuildHeavyPollPaused,
  getGuildCooldownRemainingMs,
  isGlobalRateLimited,
} = require('./nitrado');
const {
  upsertPlayer,
  searchPlayers,
  getPlayerById,
  normalizeOnlinePlayer,
  profileKey,
} = require('./playerDb');

/** Cache full cluster online lists to cut Nitrado player-list spam. */
const ONLINE_CACHE_TTL_MS = 8 * 60 * 1000; // 8 minutes (5–10m band)
/** Minimum gap between starting a new full cluster scan per guild. */
const SCAN_COOLDOWN_MS = 5 * 60 * 1000;
/** Stagger between services during a live scan. */
const SERVICE_STAGGER_MS = 1500;

/** @type {Map<string, { at: number, players: any[], promise?: Promise<any[]> }>} */
const onlineCache = new Map();
/** @type {Map<string, number>} */
const lastScanStartedAt = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFakeService(serviceId) {
  return !serviceId || String(serviceId).startsWith('fake');
}

function matchesQuery(fields, query) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return false;
  const haystack = fields
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

function liveFields(normalized) {
  return [
    normalized.gamertag,
    normalized.characterName,
    normalized.specimenImplant,
    normalized.nitradoPlayerId,
    normalized.platformId,
    normalized.tribeName,
    normalized.tribeId,
    normalized.map,
    normalized.serviceId,
    normalized.serverName,
  ];
}

function profileMatchesLive(profile, live) {
  if (!profile || !live) return false;
  const pKey = profileKey(profile);
  const lKey = profileKey(live);
  if (pKey && lKey && pKey === lKey) return true;

  const pairs = [
    [profile.nitradoPlayerId, live.nitradoPlayerId],
    [profile.specimenImplant, live.specimenImplant],
    [profile.platformId, live.platformId],
  ];
  for (const [a, b] of pairs) {
    if (a && b && String(a).toLowerCase() === String(b).toLowerCase()) return true;
  }

  const pGt = profile.gamertag?.toString().toLowerCase();
  const lGt = live.gamertag?.toString().toLowerCase();
  if (pGt && lGt && pGt === lGt) return true;

  const pChar = profile.characterName?.toString().toLowerCase();
  const lChar = live.characterName?.toString().toLowerCase();
  if (pChar && lChar && pChar === lChar && pGt && lGt && pGt === lGt) return true;

  return false;
}

/**
 * Live Nitrado player list across every synced cluster service.
 * Reuses listPlayers + normalizeOnlinePlayer (same path as tracker / kick).
 */
async function fetchClusterOnlinePlayersUncached(guild) {
  const servers = guild?.servers || [];
  const online = [];

  // During global 429 cooldown, do not full-scan the cluster.
  if (isGuildHeavyPollPaused(guild)) {
    return online;
  }

  for (let i = 0; i < servers.length; i += 1) {
    if (i > 0) await sleep(SERVICE_STAGGER_MS);
    const server = servers[i];
    const serviceId = String(server.serviceId || '');
    if (isFakeService(serviceId)) continue;
    const token = tokenForServer(server, guild);
    if (!token) continue;
    if (isGlobalRateLimited(token)) continue;

    let mapName = server.map || server.name || serviceId;
    try {
      const gs = await getGameserverCached(serviceId, token);
      mapName = extractMapName(gs, mapName);
    } catch {
      // keep fallback map name
    }

    const players = await listPlayers(serviceId, token);
    if (!Array.isArray(players)) continue;

    for (const raw of players) {
      const normalized = normalizeOnlinePlayer(raw, {
        map: mapName,
        serviceId,
      });
      if (
        !normalized.gamertag &&
        !normalized.characterName &&
        !normalized.specimenImplant &&
        !normalized.nitradoPlayerId
      ) {
        continue;
      }
      online.push({
        ...normalized,
        serverName: server.name || mapName,
        online: true,
      });
    }
  }

  return online;
}

/**
 * Guild-scoped cluster scan with short TTL cache + scan cooldown.
 * Concurrent callers share one in-flight promise.
 */
async function fetchClusterOnlinePlayers(guild, guildId = null) {
  const cacheKey = String(guildId || guild?.guildId || guild?.id || '_anon');
  const now = Date.now();
  const hit = onlineCache.get(cacheKey);

  if (hit?.players && now - hit.at < ONLINE_CACHE_TTL_MS) {
    return hit.players;
  }
  if (hit?.promise) {
    return hit.promise;
  }

  // Rate-limited: never start a full cluster scan — serve stale cache / empty.
  if (isGuildHeavyPollPaused(guild)) {
    return hit?.players || [];
  }

  // Within cooldown and we still have a (slightly stale) list — reuse it.
  const lastStarted = lastScanStartedAt.get(cacheKey) || 0;
  if (hit?.players && now - lastStarted < SCAN_COOLDOWN_MS) {
    return hit.players;
  }

  lastScanStartedAt.set(cacheKey, now);
  const promise = fetchClusterOnlinePlayersUncached(guild)
    .then((players) => {
      onlineCache.set(cacheKey, { at: Date.now(), players });
      return players;
    })
    .catch((error) => {
      const prev = onlineCache.get(cacheKey);
      if (prev?.promise === promise) {
        onlineCache.delete(cacheKey);
      }
      throw error;
    });

  onlineCache.set(cacheKey, {
    at: hit?.at || 0,
    players: hit?.players,
    promise,
  });

  return promise;
}

function findLiveMatch(onlinePlayers, profile) {
  return onlinePlayers.find((live) => profileMatchesLive(profile, live)) || null;
}

/**
 * Refresh one stored profile from a live cluster scan.
 * Marks online + map/server when found; otherwise marks offline.
 */
function applyLiveStatus(guildId, profile, live) {
  if (!profile) return null;
  if (live) {
    return upsertPlayer(guildId, {
      ...live,
      online: true,
    });
  }
  return upsertPlayer(guildId, {
    gamertag: profile.gamertag,
    characterName: profile.characterName,
    specimenImplant: profile.specimenImplant,
    nitradoPlayerId: profile.nitradoPlayerId,
    platformId: profile.platformId,
    online: false,
  });
}

/**
 * Search DB + live Nitrado lists. Upserts matching online players so stored
 * fields (name, nitrado id, specimen/id2, map, etc.) are current.
 * During global 429 cooldown, refuses live scan and returns DB-only results.
 */
async function searchPlayersLive(guildId, guild, query) {
  const q = String(query || '').trim();

  if (isGuildHeavyPollPaused(guild)) {
    const mins = Math.max(1, Math.ceil(getGuildCooldownRemainingMs(guild) / 60000));
    return {
      results: searchPlayers(guildId, q).slice(0, 25),
      liveCount: 0,
      liveHits: 0,
      scanned: false,
      rateLimited: true,
      cooldownMinutes: mins,
    };
  }

  const onlinePlayers = await fetchClusterOnlinePlayers(guild, guildId);

  // Upsert live hits for this query (covers brand-new players not yet in DB)
  const liveHits = onlinePlayers.filter((p) => matchesQuery(liveFields(p), q));
  for (const live of liveHits) {
    upsertPlayer(guildId, { ...live, online: true });
  }

  // DB search (includes just-upserted live hits; matches nitradoPlayerId / platformId)
  let results = searchPlayers(guildId, q).slice(0, 25);

  // Ensure every live ID/name hit is represented (covers brand-new players)
  for (const live of liveHits) {
    const already = results.some((p) => profileMatchesLive(p, live));
    if (!already) {
      results.push(upsertPlayer(guildId, { ...live, online: true }));
    }
  }

  // Refresh online/offline for each result from the cluster scan
  results = results.map((profile) => {
    const live = findLiveMatch(onlinePlayers, profile);
    return applyLiveStatus(guildId, profile, live);
  });

  // De-dupe by id after upserts
  const byId = new Map();
  for (const profile of results) {
    if (profile?.id) byId.set(profile.id, profile);
  }

  return {
    results: [...byId.values()].slice(0, 25),
    liveCount: onlinePlayers.length,
    liveHits: liveHits.length,
    scanned: true,
    rateLimited: false,
  };
}

/**
 * Re-check one profile against a fresh live cluster scan (e.g. result picker).
 */
async function refreshProfileLive(guildId, guild, profileOrId) {
  const profile =
    typeof profileOrId === 'string'
      ? getPlayerById(guildId, profileOrId)
      : profileOrId;
  if (!profile) return null;

  if (isGuildHeavyPollPaused(guild)) {
    return profile;
  }

  const onlinePlayers = await fetchClusterOnlinePlayers(guild, guildId);
  const live = findLiveMatch(onlinePlayers, profile);
  return applyLiveStatus(guildId, profile, live);
}

module.exports = {
  fetchClusterOnlinePlayers,
  searchPlayersLive,
  refreshProfileLive,
  findLiveMatch,
  profileMatchesLive,
  ONLINE_CACHE_TTL_MS,
  SCAN_COOLDOWN_MS,
};

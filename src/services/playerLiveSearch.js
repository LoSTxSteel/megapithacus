const {
  listPlayers,
  getGameserver,
  tokenForServer,
  extractMapName,
} = require('./nitrado');
const {
  upsertPlayer,
  searchPlayers,
  getPlayerById,
  normalizeOnlinePlayer,
  profileKey,
} = require('./playerDb');

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
async function fetchClusterOnlinePlayers(guild) {
  const servers = guild?.servers || [];
  const online = [];

  await Promise.all(
    servers.map(async (server) => {
      const serviceId = String(server.serviceId || '');
      if (isFakeService(serviceId)) return;
      const token = tokenForServer(server, guild);
      if (!token) return;

      let mapName = server.map || server.name || serviceId;
      try {
        const gs = await getGameserver(serviceId, token);
        mapName = extractMapName(gs, mapName);
      } catch {
        // keep fallback map name
      }

      const players = await listPlayers(serviceId, token);
      if (!Array.isArray(players)) return;

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
    })
  );

  return online;
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
 */
async function searchPlayersLive(guildId, guild, query) {
  const q = String(query || '').trim();
  const onlinePlayers = await fetchClusterOnlinePlayers(guild);

  // Upsert live hits for this query (covers brand-new players not yet in DB)
  const liveHits = onlinePlayers.filter((p) => matchesQuery(liveFields(p), q));
  for (const live of liveHits) {
    upsertPlayer(guildId, { ...live, online: true });
  }

  // DB search (includes just-upserted live hits)
  let results = searchPlayers(guildId, q).slice(0, 25);

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

  const onlinePlayers = await fetchClusterOnlinePlayers(guild);
  const live = findLiveMatch(onlinePlayers, profile);
  return applyLiveStatus(guildId, profile, live);
}

module.exports = {
  fetchClusterOnlinePlayers,
  searchPlayersLive,
  refreshProfileLive,
  findLiveMatch,
  profileMatchesLive,
};

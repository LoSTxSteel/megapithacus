const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(PLAYERS_FILE)) {
    fs.writeFileSync(PLAYERS_FILE, JSON.stringify({ guilds: {} }, null, 2));
  }
}

function readAll() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));
  } catch {
    return { guilds: {} };
  }
}

function writeAll(data) {
  ensureStore();
  fs.writeFileSync(PLAYERS_FILE, JSON.stringify(data, null, 2));
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function emptyProfile(guildId) {
  return {
    id: newId(),
    guildId,
    gamertag: null,
    characterName: null,
    specimenImplant: null,
    tribeName: null,
    tribeId: null,
    map: null,
    serviceId: null,
    platform: 'Microsoft Store',
    firstSeen: null,
    lastSeen: null,
    lastJoin: null,
    joins: 0,
    online: false,
    mapsSeen: [],
    notes: '',
  };
}

function getGuildPlayers(guildId) {
  const all = readAll();
  if (!all.guilds[guildId]) {
    all.guilds[guildId] = { profiles: [] };
    writeAll(all);
  }
  return all.guilds[guildId].profiles;
}

function saveGuildPlayers(guildId, profiles) {
  const all = readAll();
  all.guilds[guildId] = { profiles };
  writeAll(all);
}

function profileKey(profile) {
  return (
    profile.specimenImplant ||
    profile.gamertag ||
    profile.characterName ||
    profile.id
  )
    ?.toString()
    .toLowerCase();
}

function findMatch(profiles, incoming) {
  const implant = incoming.specimenImplant?.toString().toLowerCase();
  const gamertag = incoming.gamertag?.toString().toLowerCase();
  const character = incoming.characterName?.toString().toLowerCase();

  if (implant) {
    const byImplant = profiles.find(
      (p) => p.specimenImplant?.toString().toLowerCase() === implant
    );
    if (byImplant) return byImplant;
  }
  if (gamertag) {
    const byGt = profiles.find(
      (p) => p.gamertag?.toString().toLowerCase() === gamertag
    );
    if (byGt) return byGt;
  }
  if (character && gamertag) {
    const byBoth = profiles.find(
      (p) =>
        p.characterName?.toString().toLowerCase() === character &&
        p.gamertag?.toString().toLowerCase() === gamertag
    );
    if (byBoth) return byBoth;
  }
  return null;
}

function upsertPlayer(guildId, incoming, { joined = false } = {}) {
  const profiles = getGuildPlayers(guildId);
  const now = new Date().toISOString();
  let profile = findMatch(profiles, incoming);

  if (!profile) {
    profile = emptyProfile(guildId);
    profile.firstSeen = now;
    profiles.push(profile);
  }

  if (incoming.gamertag) profile.gamertag = incoming.gamertag;
  if (incoming.characterName) profile.characterName = incoming.characterName;
  if (incoming.specimenImplant) profile.specimenImplant = String(incoming.specimenImplant);
  if (incoming.tribeName) profile.tribeName = incoming.tribeName;
  if (incoming.tribeId != null) profile.tribeId = String(incoming.tribeId);
  if (incoming.map) profile.map = incoming.map;
  if (incoming.serviceId) profile.serviceId = String(incoming.serviceId);
  if (incoming.platform) profile.platform = incoming.platform;
  if (incoming.notes) profile.notes = incoming.notes;

  profile.lastSeen = now;
  profile.online = incoming.online ?? profile.online;

  if (incoming.map) {
    const maps = new Set(profile.mapsSeen || []);
    maps.add(incoming.map);
    profile.mapsSeen = [...maps];
  }

  if (joined) {
    profile.lastJoin = now;
    profile.joins = (profile.joins || 0) + 1;
  }

  if (incoming.raw) {
    profile.lastRaw = incoming.raw;
  }

  saveGuildPlayers(guildId, profiles);
  return profile;
}

function markOfflineExcept(guildId, onlineKeys, serviceId) {
  const profiles = getGuildPlayers(guildId);
  let changed = false;
  for (const profile of profiles) {
    if (serviceId && profile.serviceId && String(profile.serviceId) !== String(serviceId)) {
      continue;
    }
    const key = profileKey(profile);
    if (profile.online && key && !onlineKeys.has(key)) {
      profile.online = false;
      changed = true;
    }
  }
  if (changed) saveGuildPlayers(guildId, profiles);
}

function searchPlayers(guildId, query) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return [];

  return getGuildPlayers(guildId).filter((p) => {
    const haystack = [
      p.gamertag,
      p.characterName,
      p.specimenImplant,
      p.tribeName,
      p.tribeId,
      p.map,
      p.serviceId,
      p.platform,
      p.notes,
      ...(p.mapsSeen || []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

function getPlayerById(guildId, id) {
  return getGuildPlayers(guildId).find((p) => p.id === id) || null;
}

/**
 * Normalize a Nitrado / gameserver player payload into our profile shape.
 */
function normalizeOnlinePlayer(raw, { map, serviceId }) {
  const gamertag =
    raw.gamertag ||
    raw.gamer_tag ||
    raw.xbox_gamertag ||
    raw.username ||
    raw.name ||
    null;

  const characterName =
    raw.character_name ||
    raw.characterName ||
    raw.player_name ||
    raw.ign ||
    raw.name ||
    gamertag;

  const specimenImplant =
    raw.specimen_implant ||
    raw.specimenImplant ||
    raw.implant_id ||
    raw.ue4_id ||
    raw.id ||
    raw.player_id ||
    null;

  const tribeName =
    raw.tribe_name || raw.tribeName || raw.tribe || raw.TribeName || null;
  const tribeId = raw.tribe_id || raw.tribeId || raw.TribeID || null;

  return {
    gamertag: gamertag ? String(gamertag) : null,
    characterName: characterName ? String(characterName) : null,
    specimenImplant: specimenImplant != null ? String(specimenImplant) : null,
    tribeName: tribeName ? String(tribeName) : null,
    tribeId: tribeId != null ? String(tribeId) : null,
    map: map || null,
    serviceId: serviceId ? String(serviceId) : null,
    platform: 'Microsoft Store',
    online: true,
    raw,
  };
}

module.exports = {
  getGuildPlayers,
  upsertPlayer,
  markOfflineExcept,
  searchPlayers,
  getPlayerById,
  normalizeOnlinePlayer,
  profileKey,
};

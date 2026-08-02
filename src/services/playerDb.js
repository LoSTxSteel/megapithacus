const fs = require('fs');
const path = require('path');
const { dataDirFrom } = require('../utils/paths');

const DATA_DIR = dataDirFrom(__dirname);
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
    nitradoPlayerId: null,
    platformId: null,
    tribeName: null,
    tribeId: null,
    map: null,
    serverName: null,
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

/** Reject Steam64 / corrupted MAX_SAFE / Nitrado internal alphanumeric IDs. */
function looksLikeSpecimenImplant(value) {
  if (value == null) return false;
  const s = String(value).trim();
  if (!/^\d{5,14}$/.test(s)) return false;
  if (s === '9007199254740991') return false;
  if (/^7656119\d{10}$/.test(s)) return false;
  return true;
}

function firstTruthy(...values) {
  for (const v of values) {
    if (v != null && String(v).trim() !== '') return v;
  }
  return null;
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
  if (incoming.characterName) {
    const char = String(incoming.characterName).trim();
    const gt = String(incoming.gamertag || profile.gamertag || '')
      .trim()
      .toLowerCase();
    // Never store gamertag echo as the character / in-game name
    const isEcho = gt && char.toLowerCase() === gt;
    if (!isEcho) {
      profile.characterName = char;
    }
  }
  if (incoming.specimenImplant && looksLikeSpecimenImplant(incoming.specimenImplant)) {
    profile.specimenImplant = String(incoming.specimenImplant).trim();
  }
  // Drop previously stored Nitrado internal / Steam / corrupted IDs mistaken for implant
  if (profile.specimenImplant && !looksLikeSpecimenImplant(profile.specimenImplant)) {
    profile.specimenImplant = null;
  }
  if (incoming.nitradoPlayerId) {
    profile.nitradoPlayerId = String(incoming.nitradoPlayerId).trim();
  }
  if (incoming.platformId) {
    profile.platformId = String(incoming.platformId).trim();
  }
  if (incoming.tribeName) profile.tribeName = incoming.tribeName;
  if (incoming.tribeId != null) profile.tribeId = String(incoming.tribeId);
  if (incoming.map) profile.map = incoming.map;
  if (incoming.serverName) profile.serverName = String(incoming.serverName);
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

/**
 * Mark players offline who are no longer in onlineKeys.
 * @returns {object[]} profiles that just left
 */
function markOfflineExcept(guildId, onlineKeys, serviceId) {
  const profiles = getGuildPlayers(guildId);
  const left = [];
  let changed = false;
  const now = new Date().toISOString();
  for (const profile of profiles) {
    if (serviceId && profile.serviceId && String(profile.serviceId) !== String(serviceId)) {
      continue;
    }
    const key = profileKey(profile);
    if (profile.online && key && !onlineKeys.has(key)) {
      profile.online = false;
      profile.lastLeave = now;
      profile.leaves = (profile.leaves || 0) + 1;
      left.push({ ...profile });
      changed = true;
    }
  }
  if (changed) saveGuildPlayers(guildId, profiles);
  return left;
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
 *
 * Nitrado Player Management shape (arkxb / ASE Xbox):
 *   { name, id, id_type, online, actions, … }
 * - `id` is Nitrado's internal kick/ban action id — NOT the specimen implant.
 * - Specimen / UE4 PlayerDataID is often in `id2` (when present) or explicit fields.
 * - Xbox: `name` is usually the gamertag; character/IGN may be `username`,
 *   `playerName`, `characterName`, etc. Never copy gamertag into characterName.
 */
function normalizeOnlinePlayer(raw, { map, serviceId }) {
  const asText = (...values) => {
    const v = firstTruthy(...values);
    return v != null ? String(v).trim() : null;
  };

  // Explicit platform / Xbox tags — never treat character fields as gamertag.
  let gamertag = asText(
    raw.gamertag,
    raw.gamer_tag,
    raw.xbox_gamertag,
    raw.xboxGamertag,
    raw.platform_name,
    raw.platformName
  );

  // Explicit character / survivor / IGN fields.
  let characterName = asText(
    raw.character_name,
    raw.characterName,
    raw.player_name,
    raw.playerName,
    raw.survivor_name,
    raw.survivorName,
    raw.ign,
    raw.char_name,
    raw.charName
  );

  const name = asText(raw.name);
  const username = asText(raw.username, raw.user_name, raw.userName);

  // ASE Xbox: `name` is the Xbox gamertag when no explicit tag is present.
  if (!gamertag && name) {
    gamertag = name;
  }

  // Only use username as gamertag when nothing else identifies the Xbox account
  // and we already have a distinct character name (or no character at all).
  if (!gamertag && username) {
    if (
      !characterName ||
      characterName.toLowerCase() !== username.toLowerCase()
    ) {
      // If username looks like the only identity field, keep as gamertag.
      if (!characterName) gamertag = username;
    }
  }

  // Prefer username / name as character when they differ from gamertag.
  if (
    !characterName &&
    username &&
    gamertag &&
    username.toLowerCase() !== gamertag.toLowerCase()
  ) {
    characterName = username;
  }
  if (
    !characterName &&
    name &&
    gamertag &&
    name.toLowerCase() !== gamertag.toLowerCase()
  ) {
    characterName = name;
  }

  // Do NOT fall back characterName → gamertag (that made In-game name wrong).

  const nitradoPlayerId = firstTruthy(raw.id);
  const idType = String(raw.id_type || raw.idType || '').toLowerCase();

  // Prefer explicit specimen / UE4 fields. Never treat Nitrado internal `id` as implant.
  const specimenCandidates = [
    raw.specimen_implant,
    raw.specimenImplant,
    raw.implant_id,
    raw.implantId,
    raw.ue4_id,
    raw.ue4Id,
    raw.player_data_id,
    raw.PlayerDataID,
    raw.id2,
    raw.player_id,
    raw.playerId,
  ];
  let specimenImplant = null;
  for (const candidate of specimenCandidates) {
    if (looksLikeSpecimenImplant(candidate)) {
      specimenImplant = String(candidate).trim();
      break;
    }
  }

  // Platform / KickPlayer network id (numeric). Keep separate from specimen.
  let platformId = firstTruthy(
    raw.platform_id,
    raw.platformId,
    raw.net_id,
    raw.netId,
    raw.unique_net_id,
    raw.UniqueNetId
  );
  if (
    !platformId &&
    nitradoPlayerId &&
    idType !== 'internal' &&
    /^\d{15,}$/.test(String(nitradoPlayerId).trim())
  ) {
    platformId = String(nitradoPlayerId).trim();
  }

  const tribeName =
    raw.tribe_name || raw.tribeName || raw.tribe || raw.TribeName || null;
  const tribeId = raw.tribe_id || raw.tribeId || raw.TribeID || null;

  return {
    gamertag: gamertag || null,
    characterName: characterName || null,
    specimenImplant,
    nitradoPlayerId: nitradoPlayerId != null ? String(nitradoPlayerId).trim() : null,
    platformId: platformId != null ? String(platformId).trim() : null,
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
  looksLikeSpecimenImplant,
};

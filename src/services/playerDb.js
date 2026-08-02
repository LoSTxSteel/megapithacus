const fs = require('fs');
const path = require('path');
const { dataDirFrom } = require('../utils/paths');
const { formatMapName } = require('../utils/mapNames');

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
  // Clear legacy rows where characterName was copied from gamertag
  if (
    profile.characterName &&
    profile.gamertag &&
    String(profile.characterName).trim().toLowerCase() ===
      String(profile.gamertag).trim().toLowerCase()
  ) {
    profile.characterName = null;
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
  if (incoming.map) {
    const friendly = formatMapName(incoming.map, String(incoming.map).trim());
    profile.map = friendly;
  }
  if (incoming.serverName) profile.serverName = String(incoming.serverName);
  if (incoming.serviceId) profile.serviceId = String(incoming.serviceId);
  if (incoming.platform) profile.platform = incoming.platform;
  if (incoming.notes) profile.notes = incoming.notes;

  profile.lastSeen = now;
  profile.online = incoming.online ?? profile.online;

  if (incoming.map) {
    const maps = new Set(profile.mapsSeen || []);
    maps.add(formatMapName(incoming.map, String(incoming.map).trim()));
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
      p.nitradoPlayerId,
      p.platformId,
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

function flattenPlayerRaw(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const nested = [raw.player, raw.info, raw.data, raw.attributes, raw.details]
    .filter((v) => v && typeof v === 'object' && !Array.isArray(v));
  // Nested first, top-level wins (spread order)
  return Object.assign({}, ...nested, raw);
}

function namesEqual(a, b) {
  if (a == null || b == null) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function distinctFrom(value, gamertag) {
  const v = value != null ? String(value).trim() : '';
  if (!v) return null;
  if (gamertag && namesEqual(v, gamertag)) return null;
  return v;
}

/**
 * Normalize a Nitrado / gameserver player payload into our profile shape.
 *
 * Nitrado Player Management shape (arkxb / ASE Xbox):
 *   { name, id, id_type, online, actions, … }
 * - `id` is Nitrado's internal kick/ban action id — NOT the specimen implant.
 * - Specimen / UE4 PlayerDataID is often in `id2` (when present) or explicit fields.
 * - Xbox arkxb: `name` is almost always the Xbox gamertag. Distinct character /
 *   IGN is rarely on this endpoint — often only in game chat logs as
 *   `Gamertag (CharacterName): message`. Never copy gamertag into characterName.
 */
function normalizeOnlinePlayer(rawInput, { map, serviceId }) {
  const raw = flattenPlayerRaw(rawInput);
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
    raw.platformName,
    raw.platform_profile_name,
    raw.PlatformProfileName,
    raw.online_id,
    raw.onlineId
  );

  // Explicit survivor / IGN fields only (NOT player_name — that is platform id in ARK).
  let characterName = asText(
    raw.character_name,
    raw.characterName,
    raw.survivor_name,
    raw.survivorName,
    raw.ign,
    raw.char_name,
    raw.charName,
    raw.character,
    raw.charname
  );

  const name = asText(raw.name);
  const username = asText(raw.username, raw.user_name, raw.userName);
  // ARK / Nitrado often use player_name for the platform gamertag — only use as
  // character when it is clearly distinct from the resolved gamertag later.
  const playerNameField = asText(raw.player_name, raw.playerName);

  // ASE Xbox: `name` is the Xbox gamertag when no explicit tag is present.
  if (!gamertag && name) {
    gamertag = name;
  }

  // player_name as platform id when still missing a gamertag
  if (!gamertag && playerNameField) {
    gamertag = playerNameField;
  }

  // Only use username as gamertag when nothing else identifies the Xbox account.
  if (!gamertag && username && !characterName) {
    gamertag = username;
  }

  // Prefer username as character when it differs from gamertag.
  if (!characterName) {
    characterName = distinctFrom(username, gamertag);
  }
  // If name was not used as gamertag (explicit tag differed), it may be IGN.
  if (!characterName && name && gamertag && !namesEqual(name, gamertag)) {
    characterName = name;
  }
  // player_name only as IGN when distinct from gamertag
  if (!characterName) {
    characterName = distinctFrom(playerNameField, gamertag);
  }

  // Final guard — never return gamertag echo as characterName
  characterName = distinctFrom(characterName, gamertag);

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
  ];
  // Only accept player_id as implant when it looks like UE4 PlayerDataID,
  // never when id_type marks the primary id as name/gamertag.
  if (idType !== 'name' && idType !== 'gamertag') {
    specimenCandidates.push(raw.player_id, raw.playerId);
  }
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
    idType !== 'name' &&
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
    raw: rawInput,
  };
}

function looksLikeTribeLabel(value) {
  const s = String(value || '').trim();
  if (!s) return true;
  if (/^tribe\s+of\b/i.test(s)) return true;
  if (/\btribe\b/i.test(s) && s.length > 48) return true;
  return false;
}

/**
 * Enrich stored profiles with in-game character names from ASE chat lines.
 * Xbox / arkxb chat commonly looks like: `Gamertag (CharacterName): message`
 * When the left side matches a known gamertag, the parentheses value is IGN
 * (unless it looks like a tribe label).
 *
 * @returns {number} profiles updated
 */
function enrichPlayersFromChatLogs(guildId, chatEntries, { serviceId, map } = {}) {
  if (!guildId || !Array.isArray(chatEntries) || !chatEntries.length) return 0;

  const byGamertag = new Map();
  for (const entry of chatEntries) {
    const gt = String(entry?.playerName || '').trim();
    const maybeChar = String(entry?.tribeOrChar || '').trim();
    if (!gt || !maybeChar) continue;
    if (namesEqual(gt, maybeChar)) continue;
    if (looksLikeTribeLabel(maybeChar)) continue;
    // Prefer the most recent non-empty IGN per gamertag
    byGamertag.set(gt.toLowerCase(), maybeChar.slice(0, 64));
  }

  if (!byGamertag.size) return 0;

  let updated = 0;
  for (const [gtKey, characterName] of byGamertag) {
    const profiles = getGuildPlayers(guildId);
    const match = profiles.find(
      (p) => p.gamertag && String(p.gamertag).trim().toLowerCase() === gtKey
    );
    if (!match) {
      // Create a lightweight profile so later joins keep the IGN
      upsertPlayer(guildId, {
        gamertag: chatEntries.find(
          (e) => String(e.playerName || '').trim().toLowerCase() === gtKey
        )?.playerName,
        characterName,
        map: map || null,
        serviceId: serviceId ? String(serviceId) : null,
        online: false,
      });
      updated += 1;
      continue;
    }
    if (
      match.characterName &&
      namesEqual(match.characterName, characterName)
    ) {
      continue;
    }
    upsertPlayer(guildId, {
      gamertag: match.gamertag,
      characterName,
      specimenImplant: match.specimenImplant,
      nitradoPlayerId: match.nitradoPlayerId,
      platformId: match.platformId,
      map: map || match.map,
      serviceId: serviceId || match.serviceId,
      online: match.online,
    });
    updated += 1;
  }
  return updated;
}

module.exports = {
  getGuildPlayers,
  upsertPlayer,
  markOfflineExcept,
  searchPlayers,
  getPlayerById,
  normalizeOnlinePlayer,
  enrichPlayersFromChatLogs,
  profileKey,
  looksLikeSpecimenImplant,
  namesEqual,
  distinctFrom,
};

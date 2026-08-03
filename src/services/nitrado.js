const { formatMapName } = require('../utils/mapNames');

const BASE = 'https://api.nitrado.net';

class NitradoError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'NitradoError';
    this.status = status;
  }
}

function resolveToken(tokenOrGuild) {
  if (!tokenOrGuild) return null;
  if (typeof tokenOrGuild === 'string') return tokenOrGuild.trim();

  const accounts = tokenOrGuild.nitradoAccounts || [];
  if (accounts.length) return accounts[0].token;
  return tokenOrGuild.nitradoToken || null;
}

/**
 * JSON.parse loses precision above Number.MAX_SAFE_INTEGER.
 * Quote 15+ digit integer literals so ARK / Xbox IDs stay exact strings.
 */
function parseJsonPreserveLargeInts(text) {
  const safe = String(text).replace(
    /([\[:{,]\s*)(-?\d{15,})(\s*[,}\]])/g,
    '$1"$2"$3'
  );
  return JSON.parse(safe);
}

const NITRADO_TIMEOUT_MS = 25_000;

async function apiRequest(method, path, token, formFields = null, { jsonBody = null } = {}) {
  if (!token) {
    throw new NitradoError(
      'No Nitrado token configured. Add one in /management → Server Setup.',
      401
    );
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };

  const options = { method, headers };

  if (jsonBody && typeof jsonBody === 'object') {
    // Some community Nitrado clients (Flutter/Java) POST JSON for player kick.
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(jsonBody);
  } else if (formFields && Object.keys(formFields).length) {
    // Official NitrAPI-PHP uses Guzzle form_params (x-www-form-urlencoded).
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    options.body = new URLSearchParams(formFields).toString();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NITRADO_TIMEOUT_MS);
  options.signal = controller.signal;

  let res;
  try {
    res = await fetch(`${BASE}${path}`, options);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new NitradoError(
        `Nitrado request timed out after ${NITRADO_TIMEOUT_MS}ms (${method} ${path})`,
        408
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  let body;
  try {
    const text = await res.text();
    body = text ? parseJsonPreserveLargeInts(text) : null;
  } catch {
    body = null;
  }

  // Nitrado often returns HTTP 200 with JSON { status: "error", message }.
  // Official PHP SDK throws on status===error even when HTTP is 200.
  if (body && typeof body === 'object' && body.status === 'error') {
    const apiMsg = body.message || body?.data?.message || 'Unknown Nitrado error';
    if (res.status === 429 || /\b429\b|rate.?limit/i.test(String(apiMsg))) {
      markGlobalRateLimited(token);
    }
    throw new NitradoError(
      `${apiMsg} (${res.status} ${method} ${path})`,
      res.status || 400
    );
  }

  if (!res.ok) {
    const apiMsg = body?.message || body?.data?.message;
    const msg = apiMsg
      ? `${apiMsg} (${res.status} ${method} ${path})`
      : `Nitrado API ${res.status} ${method} ${path}`;
    if (res.status === 429) {
      markGlobalRateLimited(token);
    }
    throw new NitradoError(msg, res.status);
  }

  if (
    body &&
    typeof body === 'object' &&
    body.status != null &&
    body.status !== 'success'
  ) {
    throw new NitradoError(
      `Unexpected Nitrado status "${body.status}" (${method} ${path})`,
      res.status || 400
    );
  }

  return body?.data ?? body;
}

async function apiGet(path, token) {
  return apiRequest('GET', path, token);
}

async function apiPost(path, token, formFields) {
  return apiRequest('POST', path, token, formFields);
}

async function apiPostJson(path, token, jsonBody) {
  return apiRequest('POST', path, token, null, { jsonBody });
}

async function apiDelete(path, token, formFields) {
  // Nitrado DELETE params are commonly accepted as query string
  const qs =
    formFields && Object.keys(formFields).length
      ? `?${new URLSearchParams(formFields)}`
      : '';
  return apiRequest('DELETE', `${path}${qs}`, token);
}

async function listServices(token) {
  const data = await apiGet('/services', token);
  return data.services || [];
}

async function getGameserver(serviceId, token) {
  const data = await apiGet(`/services/${serviceId}/gameservers`, token);
  return data.gameserver || data;
}

async function listPlayers(serviceId, token, { force = false } = {}) {
  const key = String(serviceId);
  if (!force) {
    const hit = playersListCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.players;
  }
  if (token && isGlobalRateLimited(token)) {
    const hit = playersListCache.get(key);
    return hit?.players ?? null;
  }
  try {
    const data = await apiGet(`/services/${serviceId}/gameservers/games/players`, token);
    const players = Array.isArray(data.players) ? data.players : [];
    playersListCache.set(key, {
      players,
      expiresAt: Date.now() + STATUS_CACHE_TTL_MS,
    });
    return players;
  } catch {
    return null;
  }
}

/**
 * True when a games/players entry looks like a real online player.
 * Filters empty/ghost/offline/spectator junk ASE/Nitrado sometimes leaves in the list.
 */
function isValidOnlinePlayerEntry(entry) {
  if (entry == null) return false;
  if (typeof entry === 'string') return Boolean(entry.trim());
  if (typeof entry !== 'object') return false;

  if (entry.online === false || entry.is_online === false || entry.isOnline === false) {
    return false;
  }
  // Explicit spectator / query-only slots are not population.
  const role = String(entry.role || entry.type || entry.player_type || '').toLowerCase();
  if (role === 'spectator' || role === 'query' || role === 'reserved') return false;
  if (entry.spectator === true || entry.is_spectator === true) return false;

  const name = String(
    entry.name ||
      entry.username ||
      entry.gamertag ||
      entry.gamer_tag ||
      entry.player_name ||
      entry.playerName ||
      entry.online_id ||
      ''
  ).trim();
  if (!name) return false;
  // Placeholder / anonymous ghosts
  if (/^(unknown|n\/?a|null|undefined|-)$/i.test(name)) return false;
  return true;
}

/**
 * Count live players from GET …/games/players.
 * @returns {number|null} null when the list itself is unavailable
 */
function countLivePlayers(players) {
  if (!Array.isArray(players)) return null;
  return players.filter(isValidOnlinePlayerEntry).length;
}

/**
 * Add a player identifier to the Nitrado gameserver banlist.
 */
async function addBanlist(serviceId, token, identifier) {
  return apiPost(`/services/${serviceId}/gameservers/games/banlist`, token, {
    identifier: String(identifier),
  });
}

/**
 * Remove a player identifier from the Nitrado gameserver banlist.
 */
async function removeBanlist(serviceId, token, identifier) {
  return apiDelete(`/services/${serviceId}/gameservers/games/banlist`, token, {
    identifier: String(identifier),
  });
}

/**
 * Send a raw admin command to the live gameserver console.
 * Body must be form-urlencoded `command=` (official NitrAPI-PHP).
 */
async function sendCommand(serviceId, token, command) {
  return apiPost(`/services/${serviceId}/gameservers/command`, token, {
    command: String(command),
  });
}

/**
 * Kick via Nitrado Player Management (not console KickPlayer).
 * Uses the online-list `id` from GET .../games/players — not Xbox XUID,
 * not specimen implant. ASE / arkxb products disagree on HTTP shape, so we
 * try the known variants in order until one succeeds.
 *
 * Official NitrAPI-PHP has list players + banlist only (no kick helper).
 * Working community shape (Flutter/Java DayZ tools):
 *   POST .../games/players/kick  with player_id (form or JSON)
 *
 * Note: error labels used to end with `player_id=` then `: message`, which
 * looked like an empty body — the id WAS sent via form-urlencoded.
 *
 * @param {string} [reason]
 * @param {{ name?: string|null, entry?: object|null }} [options]
 */
async function kickOnlinePlayer(serviceId, token, playerId, reason = 'Kicked', options = {}) {
  const rawId = String(playerId || '').trim();
  if (!rawId) {
    throw new NitradoError('Missing Nitrado online player id for Player Management kick', 400);
  }
  const name = options.name ? String(options.name).trim() : '';
  const id = encodeURIComponent(rawId);
  const base = `/services/${serviceId}/gameservers/games/players`;
  const reasonText = String(reason || 'Kicked').slice(0, 120);

  // Prove the body is non-empty in logs (avoids `player_id=:` false alarm).
  const formPlayerId = new URLSearchParams({ player_id: rawId }).toString();
  console.log(
    `[nitrado] Player Management kick start service=${serviceId} ` +
      `playerId=${rawId} idLen=${rawId.length} formBody=${formPlayerId}` +
      (name ? ` name=${name}` : '')
  );

  const attempts = [
    {
      label: `POST form ${base}/kick body=${formPlayerId}`,
      run: () => apiPost(`${base}/kick`, token, { player_id: rawId }),
    },
    {
      label: `POST json ${base}/kick {"player_id":…}`,
      run: () => apiPostJson(`${base}/kick`, token, { player_id: rawId }),
    },
    {
      label: `POST form ${base}/kick identifier=`,
      run: () => apiPost(`${base}/kick`, token, { identifier: rawId }),
    },
    {
      label: `POST form ${base}/kick id=`,
      run: () => apiPost(`${base}/kick`, token, { id: rawId }),
    },
    {
      label: `POST form ${base}/kick gamer_id=`,
      run: () => apiPost(`${base}/kick`, token, { gamer_id: rawId }),
    },
  ];

  if (name) {
    attempts.push(
      {
        label: `POST form ${base}/kick name=`,
        run: () => apiPost(`${base}/kick`, token, { name }),
      },
      {
        label: `POST form ${base}/kick gamertag=`,
        run: () => apiPost(`${base}/kick`, token, { gamertag: name }),
      },
      {
        label: `POST form ${base}/kick player_id= + name=`,
        run: () =>
          apiPost(`${base}/kick`, token, { player_id: rawId, name }),
      }
    );
  }

  attempts.push(
    {
      label: `GET ${base}/${rawId}?type=kick`,
      run: () =>
        apiGet(`${base}/${id}?${new URLSearchParams({ type: 'kick' })}`, token),
    },
    {
      label: `DELETE ${base}/${rawId}?type=kick`,
      run: () => apiDelete(`${base}/${id}`, token, { type: 'kick' }),
    },
    {
      label: `DELETE ${base}/${rawId}?reason=`,
      run: () => apiDelete(`${base}/${id}`, token, { reason: reasonText }),
    },
    {
      label: `POST form ${base}/${rawId}/kick`,
      run: () => apiPost(`${base}/${id}/kick`, token, { player_id: rawId }),
    },
    {
      label: `POST json ${base}/${rawId}/kick`,
      run: () => apiPostJson(`${base}/${id}/kick`, token, { player_id: rawId }),
    }
  );

  const errors = [];
  for (const attempt of attempts) {
    try {
      const data = await attempt.run();
      console.log(
        `[nitrado] Player Management kick ok service=${serviceId} ` +
          `playerId=${rawId} via ${attempt.label}`
      );
      return { data, method: attempt.label, playerId: rawId };
    } catch (error) {
      const msg = error?.message || String(error);
      errors.push(`${attempt.label} → ${msg}`);
      console.warn(
        `[nitrado] Player Management kick attempt failed service=${serviceId} ` +
          `playerId=${rawId} via ${attempt.label}: ${msg}`
      );
    }
  }

  const hint =
    /could not be executed/i.test(errors.join(' '))
      ? ' Nitrado accepted the request shape but the gameserver refused the kick ' +
        '(player may already be offline, wrong map/service, or arkxb Player Management ' +
        'kick is unreliable — console KickPlayer also typically 500s on ASE).'
      : '';

  throw new NitradoError(
    `Player Management kick failed for player ${rawId} on service ${serviceId}. ` +
      errors.slice(0, 4).join(' | ') +
      hint,
    500
  );
}

/**
 * Find an online Nitrado player entry by gamertag / character name.
 */
async function findOnlinePlayer(serviceId, token, name) {
  const target = String(name || '')
    .trim()
    .toLowerCase();
  if (!target) return null;
  const players = await listPlayers(serviceId, token);
  if (!Array.isArray(players)) return null;
  return (
    players.find((p) => {
      const names = [
        p?.gamertag,
        p?.gamer_tag,
        p?.name,
        p?.username,
        p?.characterName,
        p?.character_name,
        p?.playerName,
        p?.player_name,
      ]
        .filter(Boolean)
        .map((v) => String(v).trim().toLowerCase());
      return names.some((n) => n === target);
    }) || null
  );
}

/**
 * Power control against real NitrAPI routes (official PHP SDK):
 * - start:   POST /services/{id}/gameservers/games/start  body: game=<folder short>
 * - stop:    POST /services/{id}/gameservers/stop
 * - restart: POST /services/{id}/gameservers/restart
 * There is no POST /gameservers/start — that path 404s.
 *
 * @param {'start'|'stop'|'restart'} action
 */
async function gameserverPower(serviceId, token, action) {
  if (action === 'start') return startGameserver(serviceId, token);
  if (action === 'stop') return stopGameserver(serviceId, token);
  if (action === 'restart') return restartGameserver(serviceId, token);
  throw new NitradoError(`Unknown power action: ${action}`, 400);
}

/**
 * Start the installed game on a service.
 * Nitrado requires the game folder short (e.g. arkxb), from gameserver.game.
 * @param {string} [gameShort] Optional override; otherwise fetched live.
 */
async function startGameserver(serviceId, token, gameShort = null) {
  let game = gameShort ? String(gameShort) : null;
  if (!game) {
    const gameserver = await getGameserver(serviceId, token);
    game = gameserver?.game ? String(gameserver.game) : null;
  }
  if (!game) {
    throw new NitradoError(
      `Cannot start service ${serviceId}: Nitrado did not return gameserver.game (folder short).`,
      400
    );
  }

  try {
    return await apiPost(`/services/${serviceId}/gameservers/games/start`, token, {
      game,
    });
  } catch (error) {
    if (error instanceof NitradoError && error.status === 404) {
      throw new NitradoError(
        `Start failed (404) for service ${serviceId} game "${game}". ` +
          'Expected POST /services/{id}/gameservers/games/start — confirm service ID and that the game is installed.',
        404
      );
    }
    throw error;
  }
}

async function stopGameserver(serviceId, token) {
  try {
    return await apiPost(`/services/${serviceId}/gameservers/stop`, token);
  } catch (error) {
    if (error instanceof NitradoError && error.status === 404) {
      throw new NitradoError(
        `Stop failed (404) for service ${serviceId}. ` +
          'Expected POST /services/{id}/gameservers/stop — confirm the service ID.',
        404
      );
    }
    throw error;
  }
}

async function restartGameserver(serviceId, token) {
  try {
    return await apiPost(`/services/${serviceId}/gameservers/restart`, token);
  } catch (error) {
    if (error instanceof NitradoError && error.status === 404) {
      throw new NitradoError(
        `Restart failed (404) for service ${serviceId}. ` +
          'Expected POST /services/{id}/gameservers/restart — confirm the service ID.',
        404
      );
    }
    throw error;
  }
}

/**
 * Update one gameserver setting.
 * Official: POST /services/{id}/gameservers/settings
 * Body (form-urlencoded): category, key, value
 */
async function updateGameserverSetting(serviceId, token, category, key, value) {
  const cat = String(category);
  const k = String(key);
  const v = value == null ? '' : String(value);
  const path = `/services/${serviceId}/gameservers/settings`;

  // Never log password values — only path + category/key for Cybrancee debugging.
  console.log(`[nitrado] POST ${path} category=${cat} key=${k}`);

  const data = await apiPost(path, token, {
    category: cat,
    key: k,
    value: v,
  });

  // Non-secret settings are usually echoed; passwords may be masked/omitted.
  const isSecret = /pass/i.test(k);
  const written = data?.settings?.[cat]?.[k];
  if (
    !isSecret &&
    data?.settings &&
    written !== undefined &&
    String(written) !== v
  ) {
    throw new NitradoError(
      `Nitrado accepted settings POST but ${cat}/${k} is still "${String(written).slice(0, 40)}"`,
      400
    );
  }

  return data;
}

function findSettingKey(settings, predicate) {
  if (!settings || typeof settings !== 'object') return null;
  for (const [category, block] of Object.entries(settings)) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const key of Object.keys(block)) {
      if (predicate(category, key)) {
        return { category, key };
      }
    }
  }
  return null;
}

function listSettingKeys(settings) {
  const out = [];
  if (!settings || typeof settings !== 'object') return out;
  for (const [category, block] of Object.entries(settings)) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const key of Object.keys(block)) {
      out.push(`${category}/${key}`);
    }
  }
  return out;
}

function resolveSettingOrThrow(settings, predicate, label, preferredFallbacks = []) {
  const match = findSettingKey(settings, predicate);
  if (match) return match;

  // Prefer known fallbacks only when that exact key exists (PHP SDK hasSetting).
  for (const fb of preferredFallbacks) {
    if (settings?.[fb.category] && fb.key in settings[fb.category]) {
      return fb;
    }
  }

  const available = listSettingKeys(settings)
    .filter((p) => /name|pass|host|admin/i.test(p))
    .slice(0, 24);
  const hint = available.length
    ? ` Nearby keys: ${available.join(', ')}`
    : ' No name/password keys found in gameserver.settings — is this service a gameserver?';

  throw new NitradoError(
    `Cannot resolve Nitrado setting for ${label}.${hint}`,
    400
  );
}

/**
 * Set in-game / panel server display name via Nitrado settings.
 * Resolves category/key from live settings (required — no silent guessed keys).
 */
async function setServerName(serviceId, token, name) {
  const gameserver = await getGameserver(serviceId, token);
  const settings = gameserver.settings || {};
  const match = resolveSettingOrThrow(
    settings,
    (_cat, key) =>
      /^server[-_]?name$/i.test(key) ||
      /^hostname$/i.test(key) ||
      /^session[-_]?name$/i.test(key),
    'server name',
    [
      { category: 'general', key: 'server-name' },
      { category: 'general', key: 'hostname' },
    ]
  );

  return updateGameserverSetting(
    serviceId,
    token,
    match.category,
    match.key,
    String(name).slice(0, 100)
  );
}

/**
 * Set join password via Nitrado settings (not admin password).
 * Resolves category/key from live settings (required — no silent guessed keys).
 */
async function setServerPassword(serviceId, token, password) {
  const gameserver = await getGameserver(serviceId, token);
  const settings = gameserver.settings || {};
  const match = resolveSettingOrThrow(
    settings,
    (_cat, key) => {
      if (/admin/i.test(key)) return false;
      return (
        /^server[-_]?password$/i.test(key) ||
        /^password$/i.test(key) ||
        /^ServerPassword$/i.test(key)
      );
    },
    'join password',
    [
      { category: 'general', key: 'password' },
      { category: 'general', key: 'server-password' },
    ]
  );

  return updateGameserverSetting(
    serviceId,
    token,
    match.category,
    match.key,
    password == null ? '' : String(password)
  );
}

/**
 * Set admin password via Nitrado settings (not join/server password).
 * Resolves category/key from live settings (required — no silent guessed keys).
 */
async function setAdminPassword(serviceId, token, password) {
  const gameserver = await getGameserver(serviceId, token);
  const settings = gameserver.settings || {};
  const match = resolveSettingOrThrow(
    settings,
    (_cat, key) => {
      return (
        /admin[-_]?password/i.test(key) ||
        /^serveradminpassword$/i.test(key) ||
        /^AdminPassword$/i.test(key)
      );
    },
    'admin password',
    [
      { category: 'general', key: 'admin-password' },
      { category: 'general', key: 'server-admin-password' },
    ]
  );

  return updateGameserverSetting(
    serviceId,
    token,
    match.category,
    match.key,
    password == null ? '' : String(password)
  );
}

function extractMapName(gameserver, fallback) {
  const settings = gameserver.settings || {};
  const configBlock = settings.config || {};
  const general = settings.general || {};

  const raw =
    configBlock.map ||
    configBlock.Map ||
    configBlock.ServerMap ||
    general.map ||
    gameserver.query?.map ||
    gameserver.game_human ||
    fallback;

  if (raw == null || String(raw).trim() === '') return fallback;
  return formatMapName(raw, fallback != null ? String(fallback) : 'Unknown map');
}

/**
 * Live Nitrado / in-game display name from gameserver settings or query.
 * Prefers settings hostname / server-name / session-name (same keys as setServerName).
 */
function extractServerName(gameserver) {
  if (!gameserver || typeof gameserver !== 'object') return null;

  const settings = gameserver.settings || {};
  const general = settings.general || {};
  const configBlock = settings.config || {};
  const query = gameserver.query || {};

  const fromSettings = findSettingKey(
    settings,
    (_cat, key) =>
      /^server[-_]?name$/i.test(key) ||
      /^hostname$/i.test(key) ||
      /^session[-_]?name$/i.test(key)
  );

  const candidates = [
    fromSettings ? settings[fromSettings.category]?.[fromSettings.key] : null,
    general['server-name'],
    general.hostname,
    general['session-name'],
    general.servername,
    configBlock['server-name'],
    configBlock.hostname,
    configBlock['session-name'],
    query.name,
    query.hostname,
    query.server_name,
    query.servername,
    gameserver.hostname,
  ];

  for (const value of candidates) {
    if (value == null) continue;
    const trimmed = String(value).trim();
    if (trimmed) return trimmed.slice(0, 100);
  }
  return null;
}

function isOnline(status) {
  if (!status) return false;
  const s = String(status).toLowerCase();
  return s === 'started' || s === 'online' || s === 'running';
}

async function testToken(token) {
  const services = await listServices(token);
  return {
    ok: true,
    serviceCount: services.length,
    services,
  };
}

/**
 * Query one Nitrado ASE (Microsoft Store / Xbox) service for /pop.
 * Cached ~12m so pop, tracker, logs, and /servermanager share one pull.
 */
async function queryService(server, token, { force = false } = {}) {
  const auth = token || server.token;
  const cacheKey = String(server.serviceId);
  if (!force) {
    const hit = statusResultCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      return { ...hit.result, cached: true };
    }
  }

  if (auth && isGlobalRateLimited(auth)) {
    const hit = statusResultCache.get(cacheKey);
    if (hit?.result) {
      // Do not present a stale cached pop as current online count.
      return {
        ...hit.result,
        cached: true,
        stale: true,
        rateLimited: true,
        playersUnknown: true,
      };
    }
    return {
      ok: false,
      id: server.id,
      serviceId: server.serviceId,
      liveName: null,
      name: server.name,
      map: server.map || server.name,
      players: null,
      maxPlayers: 0,
      status: 'rate_limited',
      online: false,
      error: 'Nitrado rate limited — using cooldown',
      playerNames: [],
      rateLimited: true,
      playersUnknown: true,
      stale: true,
    };
  }

  try {
    const [gameserver, players] = await Promise.all([
      getGameserver(server.serviceId, auth),
      listPlayers(server.serviceId, auth),
    ]);

    gameserverCache.set(String(server.serviceId), {
      gameserver,
      expiresAt: Date.now() + GAMESERVER_CACHE_TTL_MS,
    });

    const online = isOnline(gameserver.status);
    const maxPlayers = Number(gameserver.slots || gameserver.query?.max_players || 0);
    const liveCount = countLivePlayers(players);

    // Prefer live games/players list. Never trust raw player_current alone —
    // ASE/Nitrado often leaves stale query counts after everyone leaves.
    let playerCount = null;
    let playersUnknown = false;
    if (!online) {
      playerCount = 0;
    } else if (liveCount != null) {
      playerCount = liveCount;
      // Cross-check: if query claims players but live list is empty, trust live list (0).
      // If query is lower than a ghost-inflated list we already filtered empties above.
    } else {
      // games/players unavailable — do not invent pop from player_current / slots.
      playersUnknown = true;
      playerCount = null;
    }

    const liveName = extractServerName(gameserver);
    const playerNames = Array.isArray(players)
      ? players
          .filter(isValidOnlinePlayerEntry)
          .map((p) =>
            typeof p === 'string'
              ? p.trim()
              : p.name || p.username || p.gamertag || p.player_name || ''
          )
          .map((n) => String(n).trim())
          .filter(Boolean)
      : [];

    const result = {
      ok: true,
      id: server.id,
      serviceId: server.serviceId,
      liveName: liveName || null,
      name: liveName || server.name,
      map: extractMapName(gameserver, server.map || server.name),
      players: online ? playerCount : 0,
      maxPlayers,
      status: gameserver.status || 'unknown',
      game: gameserver.game_human || gameserver.game || 'ARK: Survival Evolved',
      online,
      playerNames: online ? playerNames : [],
      playersUnknown: online ? playersUnknown : false,
      stale: false,
      rateLimited: false,
    };
    statusResultCache.set(cacheKey, {
      result,
      expiresAt: Date.now() + STATUS_CACHE_TTL_MS,
    });
    return result;
  } catch (error) {
    if (is429(error)) {
      markRateLimited(server.serviceId, auth);
      const hit = statusResultCache.get(cacheKey);
      if (hit?.result) {
        return {
          ...hit.result,
          cached: true,
          stale: true,
          rateLimited: true,
          playersUnknown: true,
        };
      }
    }
    return {
      ok: false,
      id: server.id,
      serviceId: server.serviceId,
      liveName: null,
      name: server.name,
      map: server.map || server.name,
      players: null,
      maxPlayers: 0,
      status: 'error',
      online: false,
      error: error.message,
      playerNames: [],
      playersUnknown: true,
      stale: true,
    };
  }
}

function tokenForServer(server, guild) {
  if (server.token) return server.token;
  const accounts = guild?.nitradoAccounts || [];
  if (server.accountId) {
    const match = accounts.find((a) => a.id === server.accountId);
    if (match) return match.token;
  }
  return resolveToken(guild);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Query every synced service. Staggers requests so a cluster does not burst
 * gameservers + games/players in parallel.
 */
async function queryCluster(servers, guild, { staggerMs = SERVICE_QUERY_STAGGER_MS } = {}) {
  const list = servers || [];
  const results = [];
  for (let i = 0; i < list.length; i += 1) {
    if (i > 0 && staggerMs > 0) await sleep(staggerMs);
    const server = list[i];
    results.push(await queryService(server, tokenForServer(server, guild)));
  }
  const online = results.filter((r) => r.online);
  const knownCounts = results.filter(
    (r) => !r.playersUnknown && Number.isFinite(Number(r.players))
  );
  const totalPlayers = knownCounts.reduce((sum, r) => sum + Number(r.players), 0);
  const totalSlots = results.reduce((sum, r) => sum + (r.maxPlayers || 0), 0);
  const anyUnknown = results.some((r) => r.playersUnknown);

  return {
    results: results.sort(
      (a, b) => (Number(b.players) || 0) - (Number(a.players) || 0)
    ),
    totalPlayers,
    totalSlots,
    onlineMaps: online.length,
    totalMaps: results.length,
    playersUnknown: anyUnknown,
  };
}

/**
 * One shared cluster status snapshot per guild per interval.
 * Pop, tracker, and log boards all reuse this instead of each calling query.
 */
async function getGuildClusterSnapshot(guild, guildId = null, { force = false } = {}) {
  const key = String(guildId || guild?.guildId || guild?.id || '_anon');
  const now = Date.now();
  const hit = guildClusterSnapshots.get(key);

  if (!force && hit?.cluster && now - hit.at < CLUSTER_SNAPSHOT_TTL_MS) {
    return { ...hit.cluster, cached: true };
  }
  if (!force && hit?.promise) {
    return hit.promise;
  }

  // During global 429 cooldown, never start a fresh cluster poll.
  if (!force && isGuildHeavyPollPaused(guild)) {
    if (hit?.cluster) {
      return { ...hit.cluster, cached: true, stale: true, rateLimited: true };
    }
    // Fall through to queryCluster — queryService returns cached/stale stubs.
  }

  const servers = guild?.servers || [];
  const promise = queryCluster(servers, guild)
    .then((cluster) => {
      guildClusterSnapshots.set(key, { at: Date.now(), cluster });
      return cluster;
    })
    .catch((error) => {
      const prev = guildClusterSnapshots.get(key);
      if (prev?.promise === promise) {
        guildClusterSnapshots.delete(key);
      }
      throw error;
    });

  guildClusterSnapshots.set(key, {
    at: hit?.at || 0,
    cluster: hit?.cluster,
    promise,
  });

  return promise;
}

async function describeService(serviceId, token) {
  const gameserver = await getGameserver(serviceId, token);
  return {
    serviceId: String(serviceId),
    status: gameserver.status,
    game: gameserver.game_human || gameserver.game,
    map: extractMapName(gameserver, 'Unknown map'),
    slots: gameserver.slots,
    ip: gameserver.ip,
    port: gameserver.port,
  };
}

async function listAllServicesForGuild(guild) {
  const accounts = guild.nitradoAccounts || [];
  const collected = [];

  for (const account of accounts) {
    try {
      const services = await listServices(account.token);
      for (const service of services) {
        collected.push({
          accountId: account.id,
          accountLabel: account.label,
          service,
        });
      }
    } catch (error) {
      collected.push({
        accountId: account.id,
        accountLabel: account.label,
        error: error.message,
      });
    }
  }

  return collected;
}

async function listFiles(serviceId, token, dir) {
  const params = new URLSearchParams();
  if (dir) params.set('dir', dir);
  const qs = params.toString();
  const data = await apiGet(
    `/services/${serviceId}/gameservers/file_server/list${qs ? `?${qs}` : ''}`,
    token
  );
  return data.entries || [];
}

async function downloadFileText(serviceId, token, filePath) {
  const params = new URLSearchParams({ file: filePath });
  const data = await apiGet(
    `/services/${serviceId}/gameservers/file_server/download?${params}`,
    token
  );
  const url = data?.token?.url;
  const fileToken = data?.token?.token;
  if (!url) {
    throw new NitradoError(`No download URL for ${filePath}`, 404);
  }

  const res = await fetch(fileToken ? `${url}?token=${encodeURIComponent(fileToken)}` : url);
  if (!res.ok) {
    throw new NitradoError(`Download failed for ${filePath} (${res.status})`, res.status);
  }
  return res.text();
}

async function seekFileText(
  serviceId,
  token,
  filePath,
  offset = 0,
  length = 100000,
  mode = 'raw'
) {
  const params = new URLSearchParams({
    file: filePath,
    offset: String(offset),
    length: String(length),
    mode: String(mode || 'raw'),
  });
  const data = await apiGet(
    `/services/${serviceId}/gameservers/file_server/seek?${params}`,
    token
  );
  const url = data?.token?.url;
  const fileToken = data?.token?.token;
  if (!url) {
    throw new NitradoError(`No seek URL for ${filePath}`, 404);
  }
  const res = await fetch(fileToken ? `${url}?token=${encodeURIComponent(fileToken)}` : url);
  if (!res.ok) {
    throw new NitradoError(`Seek failed for ${filePath} (${res.status})`, res.status);
  }
  return res.text();
}

async function pathSize(serviceId, token, filePath) {
  try {
    const params = new URLSearchParams({ path: filePath });
    const data = await apiGet(
      `/services/${serviceId}/gameservers/file_server/size?${params}`,
      token
    );
    return Number(data?.size || 0);
  } catch (error) {
    // Propagate rate limits so callers can back off; other errors → unknown size.
    if (is429(error)) throw error;
    return 0;
  }
}

async function getServiceLogs(serviceId, token, page = 1) {
  try {
    const data = await apiGet(`/services/${serviceId}/logs?page=${page}`, token);
    return data.logs || data || [];
  } catch {
    return [];
  }
}

async function listFileBookmarks(serviceId, token) {
  try {
    const data = await apiGet(
      `/services/${serviceId}/gameservers/file_server/bookmarks`,
      token
    );
    return data.bookmarks || data || [];
  } catch {
    return [];
  }
}

const LOG_TAIL_BYTES = 160000;
/** Max 1 log file read per service per cycle (seek/tail only when possible). */
const MAX_LOG_FILES = 1;
/** Known-good Logs paths — prefer seek/tail; avoid re-list for 1h. */
const LOG_PATH_CACHE_TTL_MS = 60 * 60 * 1000;
/** Directory listings — at most once per hour per service/dir unless path miss. */
const LIST_CACHE_TTL_MS = 60 * 60 * 1000;
const LIST_EMPTY_CACHE_TTL_MS = 5 * 60 * 1000;
const GAMESERVER_CACHE_TTL_MS = 20 * 60 * 1000;
/** Global token cooldown after any 429 — pauses ALL Nitrado heavy polls. */
const GLOBAL_RATE_LIMIT_MS = 60 * 60 * 1000;
/**
 * Per-service status / players cache. Long enough that pop + tracker + logs
 * share one gameservers/games/players pull per interval.
 */
const STATUS_CACHE_TTL_MS = 12 * 60 * 1000;
/** Guild-level cluster snapshot shared by pop, tracker, and log boards. */
const CLUSTER_SNAPSHOT_TTL_MS = 12 * 60 * 1000;
/** Stagger between services in a cluster query (1–2s). */
const SERVICE_QUERY_STAGGER_MS = 1500;
/** Cap list attempts per fetch (path miss only — prefer seek/tail). */
const MAX_LIST_ATTEMPTS = 1;

/** @type {Map<string, { dir: string, paths: { name: string, path: string }[], username?: string, game?: string, expiresAt: number }>} */
const logPathCache = new Map();
/** @type {Map<string, { entries: any[], expiresAt: number }>} */
const listCache = new Map();
/** @type {Map<string, { until: number, failures: number, warned: boolean }>} */
const rateLimitState = new Map();
/** token fingerprint → global cooldown (shared across all services on that token). */
/** @type {Map<string, { until: number, warned: boolean }>} */
const globalTokenCooldown = new Map();
/** @type {Map<string, { gameserver: any, expiresAt: number }>} */
const gameserverCache = new Map();
/** @type {Map<string, { result: any, expiresAt: number }>} */
const statusResultCache = new Map();
/** @type {Map<string, { players: any[]|null, expiresAt: number }>} */
const playersListCache = new Map();
/** @type {Map<string, { at: number, cluster?: any, promise?: Promise<any> }>} */
const guildClusterSnapshots = new Map();
/** key → last warn timestamp (cooldown window). */
const logWarnAt = new Map();

function warnLogCooldown(key, message, windowMs = 10 * 60 * 1000) {
  const last = logWarnAt.get(key) || 0;
  if (Date.now() - last < windowMs) return;
  logWarnAt.set(key, Date.now());
  console.warn(message);
}

function is429(error) {
  if (!error) return false;
  if (error.status === 429) return true;
  return /\b429\b/.test(String(error.message || ''));
}

/** Stable fingerprint — never log the full token. */
function tokenFingerprint(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  return `tk:${t.slice(-20)}`;
}

function markGlobalRateLimited(token) {
  const key = tokenFingerprint(token);
  if (!key) return GLOBAL_RATE_LIMIT_MS;
  const now = Date.now();
  const prev = globalTokenCooldown.get(key);
  const inWindow = prev && now < prev.until;
  const until = now + GLOBAL_RATE_LIMIT_MS;
  const mins = Math.round(GLOBAL_RATE_LIMIT_MS / 60000);
  const resumeIso = new Date(until).toISOString();
  globalTokenCooldown.set(key, { until, warned: true });
  // One clear line when entering cooldown (not on every subsequent 429).
  if (!(inWindow && prev.warned)) {
    console.warn(
      `Nitrado rate limited — pausing all Nitrado polls until ${resumeIso} (~${mins}m)`
    );
  }
  return GLOBAL_RATE_LIMIT_MS;
}

function isGlobalRateLimited(token) {
  const key = tokenFingerprint(token);
  if (!key) return false;
  const st = globalTokenCooldown.get(key);
  return Boolean(st && Date.now() < st.until);
}

function getGlobalCooldownRemainingMs(token) {
  const key = tokenFingerprint(token);
  if (!key) return 0;
  const st = globalTokenCooldown.get(key);
  if (!st) return 0;
  return Math.max(0, st.until - Date.now());
}

/** True if any Nitrado token on this guild is in the global 429 cooldown. */
function isGuildHeavyPollPaused(guild) {
  if (!guild) return false;
  const tokens = new Set();
  for (const account of guild.nitradoAccounts || []) {
    if (account?.token) tokens.add(account.token);
  }
  if (guild.nitradoToken) tokens.add(guild.nitradoToken);
  for (const server of guild.servers || []) {
    if (server?.token) tokens.add(server.token);
  }
  for (const token of tokens) {
    if (isGlobalRateLimited(token)) return true;
  }
  return false;
}

function getGuildCooldownRemainingMs(guild) {
  if (!guild) return 0;
  let max = 0;
  const tokens = new Set();
  for (const account of guild.nitradoAccounts || []) {
    if (account?.token) tokens.add(account.token);
  }
  if (guild.nitradoToken) tokens.add(guild.nitradoToken);
  for (const server of guild.servers || []) {
    if (server?.token) tokens.add(server.token);
  }
  for (const token of tokens) {
    max = Math.max(max, getGlobalCooldownRemainingMs(token));
  }
  return max;
}

function isRateLimited(serviceId, token = null) {
  if (token && isGlobalRateLimited(token)) return true;
  const st = rateLimitState.get(String(serviceId));
  return Boolean(st && Date.now() < st.until);
}

/**
 * Mark a service (+ optional token globally) rate-limited for GLOBAL_RATE_LIMIT_MS.
 * Any 429 should pause file_server and heavy cluster polls for the whole token.
 */
function markRateLimited(serviceId, token = null) {
  const key = String(serviceId);
  const now = Date.now();
  const delay = GLOBAL_RATE_LIMIT_MS;
  const until = now + delay;
  rateLimitState.set(key, { until, failures: 1, warned: true });
  if (token) {
    markGlobalRateLimited(token);
  } else {
    const mins = Math.round(delay / 60000);
    const resumeIso = new Date(until).toISOString();
    warnLogCooldown(
      `rl:${key}`,
      `Nitrado rate limited — pausing all Nitrado polls until ${resumeIso} (~${mins}m)`,
      delay
    );
  }
  return delay;
}

function clearRateLimit(serviceId) {
  // Clear per-service only — global token cooldown must expire on its own
  // so a single success does not re-stampede the rest of the cluster.
  rateLimitState.delete(String(serviceId));
}

function getCachedGameserver(serviceId) {
  const hit = gameserverCache.get(String(serviceId));
  if (hit && hit.expiresAt > Date.now()) return hit.gameserver;
  return null;
}

/**
 * Peek cached queryService/pop status without network.
 * @param {string} serviceId
 * @param {{ maxStaleMs?: number }} [opts] allow expired entries within this window
 * @returns {object|null}
 */
function getCachedStatusResult(serviceId, { maxStaleMs = 0 } = {}) {
  const hit = statusResultCache.get(String(serviceId));
  if (!hit?.result) return null;
  const now = Date.now();
  if (hit.expiresAt > now) {
    return { ...hit.result, cached: true };
  }
  if (maxStaleMs > 0 && now - hit.expiresAt <= maxStaleMs) {
    return { ...hit.result, cached: true, stale: true };
  }
  return null;
}

async function getGameserverCached(serviceId, token) {
  const cached = getCachedGameserver(serviceId);
  if (cached) return cached;
  const gameserver = await getGameserver(serviceId, token);
  gameserverCache.set(String(serviceId), {
    gameserver,
    expiresAt: Date.now() + GAMESERVER_CACHE_TTL_MS,
  });
  return gameserver;
}

async function listFilesCached(serviceId, token, dir) {
  const key = `${serviceId}:${dir || ''}`;
  const hit = listCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.entries;
  const entries = await listFiles(serviceId, token, dir);
  const ttl = entries?.length ? LIST_CACHE_TTL_MS : LIST_EMPTY_CACHE_TTL_MS;
  listCache.set(key, { entries, expiresAt: Date.now() + ttl });
  return entries;
}

function rememberLogPaths(serviceId, dir, paths, username, game) {
  if (!dir || !paths?.length) return;
  logPathCache.set(String(serviceId), {
    dir,
    paths: paths.map((p) => ({
      name: p.name || entryBaseName(p),
      path: p.path || resolveLogPath(p, dir),
    })),
    username,
    game,
    expiresAt: Date.now() + LOG_PATH_CACHE_TTL_MS,
  });
}

function entryBaseName(entry) {
  return String(entry?.name || entry?.path || '')
    .split(/[/\\]/)
    .pop();
}

function isFileEntry(entry) {
  if (!entry) return false;
  const type = String(entry.type || '').toLowerCase();
  if (type === 'dir' || type === 'directory' || type === 'folder') return false;
  // Nitrado usually sends type=file; some listings omit type for files.
  return !type || type === 'file' || type === 'f';
}

/**
 * Score ASE game-log candidates.
 * AdminCmd / chat / join lines live in ServerGame*.log when -servergamelog is on;
 * ShooterGame.log is the UE log (sometimes also has chat). Prefer current files over
 * rotated ShooterGame_2.log archives (localeCompare sorting picked those wrongly).
 */
function scoreGameLogEntry(entry) {
  const name = entryBaseName(entry).toLowerCase();
  if (!name.endsWith('.log')) return 0;
  if (name === 'servergame.log') return 500;
  if (name === 'shootergame.log') return 400;
  if (/^servergame[\._-]/i.test(name)) return 300;
  if (/^shootergame(_\d+)?\.log$/i.test(name)) return 100;
  if (/gamelog|admin.*\.log$/i.test(name)) return 200;
  return 0;
}

function pickGameLogFiles(entries, limit = MAX_LOG_FILES) {
  return (entries || [])
    .filter((e) => isFileEntry(e) && scoreGameLogEntry(e) > 0)
    .sort((a, b) => {
      const scoreDiff = scoreGameLogEntry(b) - scoreGameLogEntry(a);
      if (scoreDiff) return scoreDiff;
      const mt =
        Number(b.modified_at || b.mtime || 0) - Number(a.modified_at || a.mtime || 0);
      if (mt) return mt;
      return Number(b.size || 0) - Number(a.size || 0);
    })
    .slice(0, limit);
}

function resolveLogPath(entry, baseDir) {
  if (entry?.path) return String(entry.path).replace(/\/+$/, '');
  const name = entryBaseName(entry);
  if (!name) return null;
  return `${String(baseDir || '').replace(/\/+$/, '')}/${name}`;
}

/**
 * Prefer seek/tail — full download often 404s while arkxb holds the log open.
 * Negative offset is Nitrado's official tailFile pattern.
 * Avoid pathSize until the size-less tail fails (saves an API call per file).
 */
async function readLogFileTail(serviceId, token, entry, baseDir) {
  const filePath = resolveLogPath(entry, baseDir);
  if (!filePath) {
    throw new NitradoError('Log entry has no path/name', 404);
  }

  const errors = [];

  // 1) Official tail: negative offset (works without a reliable size).
  try {
    const text = await seekFileText(
      serviceId,
      token,
      filePath,
      -LOG_TAIL_BYTES,
      LOG_TAIL_BYTES,
      'raw'
    );
    if (text != null) return text;
  } catch (error) {
    if (is429(error)) throw error;
    errors.push(`tail:${error.message}`);
  }

  // 2) Absolute offset when size is known (lazy size fetch).
  let size = Number(entry.size || 0);
  if (!size || !Number.isFinite(size)) {
    try {
      size = await pathSize(serviceId, token, filePath);
    } catch (error) {
      if (is429(error)) throw error;
      size = 0;
    }
  }

  if (size > 0) {
    const offset = size > LOG_TAIL_BYTES ? size - LOG_TAIL_BYTES : 0;
    try {
      const text = await seekFileText(
        serviceId,
        token,
        filePath,
        offset,
        LOG_TAIL_BYTES,
        'raw'
      );
      if (text != null) return text;
    } catch (error) {
      if (is429(error)) throw error;
      errors.push(`seek:${error.message}`);
    }
  }

  // 3) Full download last — often 404 for in-use ShooterGame.log on arkxb.
  try {
    return await downloadFileText(serviceId, token, filePath);
  } catch (error) {
    if (is429(error)) throw error;
    errors.push(`download:${error.message}`);
    throw new NitradoError(
      `Log read failed for ${filePath} (${errors.join(' | ')})`,
      error.status || 404
    );
  }
}

/**
 * Candidate Logs dirs. Prefer noftp; include ftproot once (bookmarks often use it).
 * Caller should put a cached known-good dir first and cap list attempts.
 */
function logsDirCandidates(username, game, bookmarks = []) {
  const dirs = [];
  if (username && game) {
    dirs.push(`/games/${username}/noftp/${game}/ShooterGame/Saved/Logs`);
    dirs.push(`/games/${username}/ftproot/${game}/ShooterGame/Saved/Logs`);
    dirs.push(`/games/${username}/noftp/${game}/ShooterGame/Saved/SaveGames/Logs`);
    // Nested discovery fallback — only when preferred Logs dirs miss.
    dirs.push(`/games/${username}/noftp/${game}/ShooterGame/Saved`);
  }
  for (const raw of bookmarks) {
    const path = typeof raw === 'string' ? raw : raw?.path || raw?.dir || '';
    if (!path) continue;
    if (/\/logs\/?$/i.test(path) || /Saved\/Logs/i.test(path)) {
      dirs.push(path.replace(/\/$/, ''));
    }
  }
  return [...new Set(dirs)];
}

/** Preferred ASE log filenames when a Logs dir lists oddly / omits type. */
const KNOWN_LOG_NAMES = [
  'ServerGame.log',
  'ShooterGame.log',
  'ServerGame_1.log',
  'ShooterGame_1.log',
];

function mergeLogEntries(listed, baseDir, { injectKnown = false } = {}) {
  const byPath = new Map();
  for (const entry of listed || []) {
    const path = resolveLogPath(entry, baseDir);
    if (!path || scoreGameLogEntry({ ...entry, path, name: entryBaseName(entry) }) <= 0) {
      continue;
    }
    byPath.set(path.toLowerCase(), { ...entry, path, name: entryBaseName(entry) });
  }
  if (injectKnown) {
    for (const name of KNOWN_LOG_NAMES) {
      const path = `${String(baseDir || '').replace(/\/+$/, '')}/${name}`;
      const key = path.toLowerCase();
      if (!byPath.has(key)) {
        byPath.set(key, { type: 'file', name, path, size: 0 });
      }
    }
  }
  return [...byPath.values()];
}

/**
 * Best-effort ASE log text from a Nitrado service (Xbox / Microsoft Store).
 * Uses cached Logs paths + seek/tail when possible; lists sparingly; backs off on 429.
 */
async function fetchGameLogText(serviceId, token) {
  const sid = String(serviceId);
  const chunks = [];
  const fetchedNames = [];
  let listError = null;
  let listStatus = null;
  let sawCandidates = false;
  let readFailCount = 0;
  let rateLimited = false;

  if (isRateLimited(sid, token)) {
    return {
      gameserver: getCachedGameserver(sid) || {},
      text: '',
      logFiles: [],
      rateLimited: true,
      skipped: 'rate_limited',
    };
  }

  let gameserver;
  try {
    gameserver = await getGameserverCached(sid, token);
  } catch (error) {
    if (is429(error)) {
      markRateLimited(sid, token);
      return {
        gameserver: getCachedGameserver(sid) || {},
        text: '',
        logFiles: [],
        rateLimited: true,
        skipped: 'rate_limited',
      };
    }
    throw error;
  }

  const username = gameserver.username || gameserver.user_name;
  const game = gameserver.game;
  const pathHit = logPathCache.get(sid);

  // 1) Prefer seek/tail on bookmarked paths — no list. Max 1 file per cycle.
  if (pathHit && pathHit.expiresAt > Date.now() && pathHit.paths?.length) {
    const p = pathHit.paths[0];
    const label = p.name || entryBaseName(p) || 'log';
    try {
      const text = await readLogFileTail(
        sid,
        token,
        { path: p.path, name: label, size: 0 },
        pathHit.dir
      );
      if (text && text.trim()) {
        chunks.push(text);
        fetchedNames.push(label);
      }
    } catch (error) {
      if (is429(error)) {
        markRateLimited(sid, token);
        return {
          gameserver,
          text: chunks.join('\n'),
          logFiles: fetchedNames,
          rateLimited: true,
        };
      }
      readFailCount += 1;
      warnLogCooldown(
        `${sid}:read:${label}`,
        `[nitrado] log read failed (locked/404) serviceId=${sid} file=${label}: ${error.message}`
      );
    }
    if (fetchedNames.length) {
      clearRateLimit(sid);
      pathHit.expiresAt = Date.now() + LOG_PATH_CACHE_TTL_MS;
      logPathCache.set(sid, pathHit);
      return { gameserver, text: chunks.join('\n'), logFiles: fetchedNames };
    }
    // Cached paths went stale — fall through to a capped re-list (≤1/hour).
  }

  if (isRateLimited(sid, token)) {
    return {
      gameserver,
      text: chunks.join('\n'),
      logFiles: fetchedNames,
      rateLimited: true,
      skipped: 'rate_limited',
    };
  }

  // 2) Bookmarks only when we have no known-good dir (extra API call otherwise).
  let bookmarks = [];
  if (!pathHit?.dir) {
    try {
      bookmarks = await listFileBookmarks(sid, token);
    } catch (error) {
      if (is429(error)) {
        markRateLimited(sid, token);
        return {
          gameserver,
          text: '',
          logFiles: [],
          rateLimited: true,
          skipped: 'rate_limited',
        };
      }
    }
  }

  const dirs = [];
  if (pathHit?.dir) dirs.push(pathHit.dir);
  for (const d of logsDirCandidates(username, game, bookmarks)) {
    if (!dirs.some((x) => x.toLowerCase() === d.toLowerCase())) dirs.push(d);
  }

  const seenDirs = new Set();
  let listAttempts = 0;
  // Path miss only: at most one directory list per fetch (hour-long list cache).
  const maxLists = MAX_LIST_ATTEMPTS;

  for (let i = 0; i < dirs.length; i += 1) {
    if (listAttempts >= maxLists || rateLimited) break;

    const base = dirs[i];
    const baseKey = base.toLowerCase();
    if (seenDirs.has(baseKey)) continue;
    seenDirs.add(baseKey);

    let entries;
    try {
      listAttempts += 1;
      entries = await listFilesCached(sid, token, base);
    } catch (error) {
      if (is429(error)) {
        markRateLimited(sid, token);
        rateLimited = true;
        break;
      }
      listError = error.message;
      listStatus = error.status || null;
      continue;
    }

    const inLogsDir = /\/Logs$/i.test(base);

    // Discover nested Logs/ when listing Saved/ (counts toward later attempts).
    if (!inLogsDir) {
      for (const e of entries || []) {
        const isDir =
          String(e.type || '').toLowerCase() === 'dir' ||
          String(e.type || '').toLowerCase() === 'directory';
        if (isDir && entryBaseName(e).toLowerCase() === 'logs') {
          const sub = (e.path || `${base}/Logs`).replace(/\/$/, '');
          if (!seenDirs.has(sub.toLowerCase())) dirs.push(sub);
        }
      }
    }

    const merged = mergeLogEntries(entries, base, { injectKnown: inLogsDir });
    const targets = pickGameLogFiles(merged);
    if (!targets.length) continue;
    sawCandidates = true;

    // Max 1 log file read per service per cycle.
    const target = targets[0];
    const label = target.name || entryBaseName(target) || 'log';
    try {
      const text = await readLogFileTail(sid, token, target, base);
      if (text && text.trim()) {
        chunks.push(text);
        fetchedNames.push(label);
      }
    } catch (error) {
      if (is429(error)) {
        markRateLimited(sid, token);
        rateLimited = true;
      } else {
        readFailCount += 1;
        warnLogCooldown(
          `${sid}:read:${label}`,
          `[nitrado] log read failed (locked/404) serviceId=${sid} file=${label}: ${error.message}`
        );
      }
    }

    if (fetchedNames.length) {
      clearRateLimit(sid);
      rememberLogPaths(sid, base, targets.slice(0, 1), username, game);
      break;
    }
    if (rateLimited) break;
  }

  // Panel service logs only as last-resort fallback (extra API call).
  if (!fetchedNames.length && !rateLimited) {
    try {
      const serviceLogs = await getServiceLogs(sid, token, 1);
      if (Array.isArray(serviceLogs) && serviceLogs.length) {
        chunks.push(
          serviceLogs
            .map((l) => l.message || l.text || l.content || JSON.stringify(l))
            .join('\n')
        );
      }
    } catch (error) {
      if (is429(error)) {
        markRateLimited(sid, token);
        rateLimited = true;
      }
    }
  }

  if (!fetchedNames.length && (username || game) && !rateLimited) {
    if (sawCandidates || readFailCount > 0) {
      warnLogCooldown(
        `${sid}:reads-failed`,
        `[nitrado] ASE log files found but reads failed (locked/404) serviceId=${sid}` +
          ` username=${username || '?'} game=${game || '?'}` +
          ` readFailures=${readFailCount}`
      );
    } else if (listStatus === 429 || is429({ message: listError, status: listStatus })) {
      // Should have been handled above; keep distinct for safety.
      warnLogCooldown(
        `${sid}:list-429`,
        `[nitrado] ASE log list rate limited (429) serviceId=${sid}` +
          ` username=${username || '?'} game=${game || '?'}`
      );
    } else if (listError) {
      warnLogCooldown(
        `${sid}:list-failed`,
        `[nitrado] ASE log dir list failed serviceId=${sid}` +
          ` username=${username || '?'} game=${game || '?'}` +
          ` listError=${listError}`
      );
    } else {
      warnLogCooldown(
        `${sid}:empty`,
        `[nitrado] ASE Logs dir empty / no ServerGame.log serviceId=${sid}` +
          ` username=${username || '?'} game=${game || '?'}`
      );
    }
  }

  return {
    gameserver,
    text: chunks.join('\n'),
    logFiles: fetchedNames,
    rateLimited,
  };
}

// ── ASE / arkxb save management (backups + SavedArks) ──────────────────────

const SAVE_LIST_CACHE_TTL_MS = 90 * 1000;
/** @type {Map<string, { saves: any[], expiresAt: number }>} */
const saveListCache = new Map();

const SAVE_FILE_RE = /\.(ark|arktribe|arkprofile|bak)$/i;
const DATED_ARK_RE = /^(.+?)_(\d{2}\.\d{2}\.\d{4}_\d{2}\.\d{2}\.\d{2})\.ark$/i;
const ANTI_CORRUPT_RE = /^(.+?)_AntiCorruptionBackup\.bak$/i;

function savedArksDirCandidates(username, game, bookmarks = []) {
  const dirs = [];
  const u = username ? String(username) : '';
  const g = game ? String(game) : '';
  if (u && g) {
    dirs.push(`/games/${u}/noftp/${g}/ShooterGame/Saved/SavedArks`);
    dirs.push(`/games/${u}/ftproot/${g}/ShooterGame/Saved/SavedArks`);
    dirs.push(`/games/${u}/noftp/${g}/ShooterGame/Saved`);
  }
  for (const raw of bookmarks || []) {
    const path =
      typeof raw === 'string'
        ? raw
        : raw?.path || raw?.dir || raw?.directory || raw?.value;
    if (!path) continue;
    const p = String(path);
    if (/SavedArks/i.test(p)) dirs.push(p.replace(/\/+$/, ''));
    else if (/\/Saved\/?$/i.test(p)) dirs.push(`${p.replace(/\/+$/, '')}/SavedArks`);
    else if (/ShooterGame\/Saved/i.test(p) && !/Logs/i.test(p)) {
      dirs.push(p.replace(/\/+$/, ''));
      if (!/SavedArks/i.test(p)) dirs.push(`${p.replace(/\/+$/, '')}/SavedArks`);
    }
  }
  return [...new Set(dirs.filter(Boolean))];
}

function formatBytes(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return null;
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSaveTime(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().replace('T', ' ').slice(0, 19);
  }
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().replace('T', ' ').slice(0, 19);
  return s.slice(0, 32);
}

/**
 * Infer active map .ark name from a dated backup / AntiCorruption file.
 */
function inferActiveArkName(fileName, mapHint = null) {
  const base = String(fileName || '')
    .split(/[/\\]/)
    .pop();
  const dated = base.match(DATED_ARK_RE);
  if (dated) return `${dated[1]}.ark`;
  const anti = base.match(ANTI_CORRUPT_RE);
  if (anti) return `${anti[1]}.ark`;
  if (/\.ark$/i.test(base) && !/_AntiCorruption/i.test(base)) return base;
  if (mapHint) {
    const map = String(mapHint).trim().replace(/\s+/g, '');
    if (map) return `${map}.ark`;
  }
  return base;
}

function isPastArkSave(name) {
  const n = String(name || '');
  if (DATED_ARK_RE.test(n)) return true;
  if (ANTI_CORRUPT_RE.test(n)) return true;
  // Keep non-active .bak map saves; skip plain tribe/profile for rollback list.
  if (/\.bak$/i.test(n) && !/profile|tribe/i.test(n)) return true;
  return false;
}

/**
 * Normalize GET /gameservers/backups payloads into flat restore targets.
 * Shape varies; PHP SDK restores with { game, backup }.
 */
function normalizeNitradoBackups(raw, fallbackGame = null) {
  const out = [];
  const backupsRoot = raw?.backups ?? raw;
  if (!backupsRoot) return out;

  const pushItem = (game, item, index) => {
    if (item == null) return;
    if (typeof item === 'string' || typeof item === 'number') {
      const id = String(item);
      out.push({
        kind: 'nitrado',
        id: `n:${game || 'game'}:${id}`,
        game: game || fallbackGame || 'arkxb',
        backup: id,
        label: `Nitrado backup ${id}`,
        timestamp: null,
        size: null,
      });
      return;
    }
    if (typeof item !== 'object') return;
    const backup =
      item.backup ??
      item.number ??
      item.id ??
      item.name ??
      item.timestamp ??
      item.file ??
      index;
    if (backup == null) return;
    const gameName =
      item.game || item.folder || item.folder_short || game || fallbackGame || 'arkxb';
    const ts =
      formatSaveTime(item.timestamp || item.time || item.date || item.created_at) ||
      null;
    const size = item.filesize ?? item.size ?? item.bytes ?? null;
    const sizeLabel = formatBytes(size);
    out.push({
      kind: 'nitrado',
      id: `n:${gameName}:${backup}`,
      game: String(gameName),
      backup: String(backup),
      label: [
        'Nitrado',
        ts || `backup ${backup}`,
        sizeLabel,
      ]
        .filter(Boolean)
        .join(' · '),
      timestamp: ts,
      size,
    });
  };

  const walkGameserver = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const entry = node[i];
        if (entry && typeof entry === 'object' && (entry.game || entry.folder)) {
          const g = entry.game || entry.folder;
          const list = entry.backups || entry.files || entry.items || entry.list;
          if (Array.isArray(list)) {
            list.forEach((item, idx) => pushItem(g, item, idx));
          } else {
            pushItem(g, entry, i);
          }
        } else {
          pushItem(fallbackGame, entry, i);
        }
      }
      return;
    }
    if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (Array.isArray(value)) {
          value.forEach((item, idx) => pushItem(key, item, idx));
        } else if (value && typeof value === 'object') {
          walkGameserver(value);
        }
      }
    }
  };

  if (Array.isArray(backupsRoot)) {
    walkGameserver(backupsRoot);
  } else if (typeof backupsRoot === 'object') {
    if (backupsRoot.gameserver != null) walkGameserver(backupsRoot.gameserver);
    else walkGameserver(backupsRoot);
  }

  // De-dupe by id
  const seen = new Set();
  return out.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

async function listNitradoBackups(serviceId, token) {
  const data = await apiGet(`/services/${serviceId}/gameservers/backups`, token);
  let game = null;
  try {
    const gs = await getGameserverCached(serviceId, token);
    game = gs?.game ? String(gs.game) : null;
  } catch {
    // ignore — normalize still works with fallback
  }
  return normalizeNitradoBackups(data, game);
}

async function resolveSavedArksDir(serviceId, token) {
  if (isRateLimited(serviceId, token)) {
    throw new NitradoError(
      `Nitrado file_server rate limited for service ${serviceId}. Try again shortly.`,
      429
    );
  }

  const gameserver = await getGameserverCached(serviceId, token);
  const username = gameserver.username || gameserver.user_name;
  const game = gameserver.game ? String(gameserver.game) : null;
  let bookmarks = [];
  try {
    bookmarks = await listFileBookmarks(serviceId, token);
  } catch (error) {
    if (is429(error)) {
      markRateLimited(serviceId, token);
      throw error;
    }
  }

  const candidates = savedArksDirCandidates(username, game, bookmarks);
  let lastError = null;
  for (const dir of candidates) {
    try {
      const entries = await listFilesCached(serviceId, token, dir);
      clearRateLimit(serviceId);
      const hasArk = (entries || []).some((e) =>
        SAVE_FILE_RE.test(entryBaseName(e))
      );
      // Prefer a dir that actually contains save files; accept first listable SavedArks.
      if (hasArk || /SavedArks/i.test(dir)) {
        return {
          dir,
          entries: entries || [],
          gameserver,
          username,
          game,
        };
      }
    } catch (error) {
      lastError = error;
      if (is429(error)) {
        markRateLimited(serviceId, token);
        throw error;
      }
    }
  }

  throw new NitradoError(
    `Could not locate SavedArks for service ${serviceId}` +
      (username && game ? ` (tried under /games/${username}/…/${game}/…)` : '') +
      (lastError ? `: ${lastError.message}` : '.'),
    404
  );
}

async function listArkFileSaves(serviceId, token) {
  const { dir, entries, gameserver } = await resolveSavedArksDir(serviceId, token);
  const mapHint = extractMapName(gameserver, null);
  const saves = [];

  for (const entry of entries || []) {
    if (!isFileEntry(entry)) continue;
    const name = entryBaseName(entry);
    if (!SAVE_FILE_RE.test(name)) continue;
    // Rollback list: past / dated saves (not every tribe file).
    if (!isPastArkSave(name) && !/\.ark$/i.test(name)) continue;
    // Include dated/bak always; include plain .ark as "current" for context (not restore target preferred).
    const path = entry.path || `${dir}/${name}`;
    const ts =
      formatSaveTime(entry.modified_at || entry.mtime || entry.modified || entry.timestamp) ||
      null;
    const size = entry.size ?? entry.filesize ?? null;
    const past = isPastArkSave(name);
    const sizeLabel = formatBytes(size);
    saves.push({
      kind: 'ark',
      id: `a:${Buffer.from(path).toString('base64url').slice(0, 80)}`,
      path,
      name,
      dir,
      targetName: inferActiveArkName(name, mapHint),
      current: !past && /\.ark$/i.test(name),
      label: [
        past ? 'Map save' : 'Current',
        name,
        ts,
        sizeLabel,
      ]
        .filter(Boolean)
        .join(' · '),
      timestamp: ts,
      size,
    });
  }

  // Prefer past saves first, then by timestamp/name desc
  saves.sort((a, b) => {
    if (a.current !== b.current) return a.current ? 1 : -1;
    return String(b.timestamp || b.name).localeCompare(String(a.timestamp || a.name));
  });

  return saves;
}

/**
 * Unified save/backup list for /rollback.
 * Combines Nitrado gameserver backups + dated SavedArks files.
 * Cached briefly to respect file_server rate limits.
 */
async function listSaves(serviceId, token, { force = false } = {}) {
  const key = String(serviceId);
  if (!force) {
    const hit = saveListCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.saves;
  }

  const saves = [];
  const errors = [];

  try {
    const nitrado = await listNitradoBackups(serviceId, token);
    saves.push(...nitrado);
  } catch (error) {
    errors.push(`Nitrado backups: ${error.message}`);
    if (is429(error)) markRateLimited(serviceId, token);
  }

  try {
    const ark = await listArkFileSaves(serviceId, token);
    // For rollback picker, prefer past saves; keep a few current as context only if no past.
    const past = ark.filter((s) => !s.current);
    saves.push(...(past.length ? past : ark.slice(0, 5)));
  } catch (error) {
    errors.push(`SavedArks: ${error.message}`);
    if (is429(error)) markRateLimited(serviceId, token);
  }

  // Stable short option values for Discord selects (max 100 chars)
  const withKeys = saves.map((s, index) => ({
    ...s,
    selectValue: `s${index}`,
  }));

  saveListCache.set(key, {
    saves: withKeys,
    expiresAt: Date.now() + SAVE_LIST_CACHE_TTL_MS,
    errors,
  });

  return withKeys;
}

function getCachedSaveListMeta(serviceId) {
  return saveListCache.get(String(serviceId)) || null;
}

function invalidateSaveListCache(serviceId) {
  if (serviceId == null) {
    saveListCache.clear();
    return;
  }
  saveListCache.delete(String(serviceId));
}

/**
 * Official Nitrado gameserver image restore.
 * POST /services/{id}/gameservers/backups/gameserver  { game, backup }
 */
async function restoreNitradoBackup(serviceId, token, game, backup) {
  if (!game || backup == null || backup === '') {
    throw new NitradoError('Restore requires game folder and backup id.', 400);
  }
  const data = await apiPost(
    `/services/${serviceId}/gameservers/backups/gameserver`,
    token,
    {
      game: String(game),
      backup: String(backup),
    }
  );
  invalidateSaveListCache(serviceId);
  return data;
}

async function copyGameserverFile(serviceId, token, sourcePath, targetDir, targetName) {
  return apiPost(`/services/${serviceId}/gameservers/file_server/copy`, token, {
    source_path: String(sourcePath),
    target_path: String(targetDir),
    target_name: String(targetName),
  });
}

/**
 * Restore a listed save:
 * - kind=nitrado → official backup restore (may take 10–30m; IP/settings can change)
 * - kind=ark → stop, copy dated save over active map .ark, optionally start
 */
async function restoreSave(serviceId, token, save, { startAfter = true } = {}) {
  if (!save || !save.kind) {
    throw new NitradoError('No save selected.', 400);
  }

  if (save.kind === 'nitrado') {
    const data = await restoreNitradoBackup(serviceId, token, save.game, save.backup);
    return {
      ok: true,
      kind: 'nitrado',
      restarted: false,
      needsRestart: true,
      warning:
        'Nitrado gameserver restore can take 10–30 minutes and may change the server IP / settings.',
      data,
    };
  }

  if (save.kind === 'ark') {
    if (save.current) {
      throw new NitradoError(
        `Refusing to restore current active save "${save.name}" onto itself. Pick a dated backup.`,
        400
      );
    }
    const targetName = save.targetName || inferActiveArkName(save.name);
    const targetDir = save.dir || String(save.path).replace(/[/\\][^/\\]+$/, '');
    if (!save.path || !targetDir || !targetName) {
      throw new NitradoError('Save path incomplete for file restore.', 400);
    }

    let stopped = false;
    try {
      await stopGameserver(serviceId, token);
      stopped = true;
    } catch (error) {
      // Continue if already stopped; fail hard on other errors.
      if (!/already|stopped|offline|not running/i.test(String(error.message || ''))) {
        throw error;
      }
    }

    await copyGameserverFile(serviceId, token, save.path, targetDir, targetName);
    invalidateSaveListCache(serviceId);

    let started = false;
    if (startAfter) {
      await startGameserver(serviceId, token);
      started = true;
    }

    return {
      ok: true,
      kind: 'ark',
      stopped,
      started,
      restarted: started,
      needsRestart: !started,
      targetName,
      sourceName: save.name,
    };
  }

  throw new NitradoError(`Unknown save kind: ${save.kind}`, 400);
}

/**
 * Request upload token then POST binary to Nitrado's upload URL.
 * Official PHP SDK: POST upload { path, file } → POST body to token.url with header token.
 */
async function uploadFileBinary(serviceId, token, dirPath, fileName, buffer) {
  const data = await apiPost(
    `/services/${serviceId}/gameservers/file_server/upload`,
    token,
    {
      path: String(dirPath),
      file: String(fileName),
    }
  );
  const uploadUrl = data?.token?.url;
  const uploadToken = data?.token?.token;
  if (!uploadUrl || !uploadToken) {
    throw new NitradoError(`No upload token for ${fileName}`, 502);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let res;
  try {
    res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/binary',
        token: uploadToken,
      },
      body: buffer,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new NitradoError(`Upload timed out for ${fileName}`, 408);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw new NitradoError(
      `Nitrado upload failed for ${fileName} (${res.status})${detail ? `: ${detail}` : ''}`,
      res.status
    );
  }

  return true;
}

/**
 * Upload a custom ASE save into SavedArks.
 * Best practice: stop → replace → start.
 */
async function uploadSave(
  serviceId,
  token,
  buffer,
  fileName,
  { startAfter = true, stopFirst = true } = {}
) {
  const name = String(fileName || '')
    .split(/[/\\]/)
    .pop();
  if (!SAVE_FILE_RE.test(name)) {
    throw new NitradoError(
      `Unsupported save extension for "${name}". Use .ark (or .arktribe / .bak).`,
      400
    );
  }
  if (!buffer || !Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw new NitradoError('Upload requires a binary buffer.', 400);
  }
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  const { dir } = await resolveSavedArksDir(serviceId, token);

  if (stopFirst) {
    try {
      await stopGameserver(serviceId, token);
    } catch (error) {
      if (!/already|stopped|offline|not running/i.test(String(error.message || ''))) {
        throw error;
      }
    }
  }

  await uploadFileBinary(serviceId, token, dir, name, body);
  invalidateSaveListCache(serviceId);
  // Also clear list cache for this dir so next list sees the new file
  listCache.delete(`${serviceId}:${dir}`);

  let started = false;
  if (startAfter) {
    await startGameserver(serviceId, token);
    started = true;
  }

  return {
    ok: true,
    dir,
    fileName: name,
    bytes: body.length,
    started,
    needsRestart: !started,
  };
}

module.exports = {
  NitradoError,
  resolveToken,
  listServices,
  getGameserver,
  listPlayers,
  isValidOnlinePlayerEntry,
  countLivePlayers,
  findOnlinePlayer,
  addBanlist,
  removeBanlist,
  sendCommand,
  kickOnlinePlayer,
  gameserverPower,
  startGameserver,
  stopGameserver,
  restartGameserver,
  updateGameserverSetting,
  setServerName,
  setServerPassword,
  setAdminPassword,
  queryService,
  getGameserverCached,
  queryCluster,
  getGuildClusterSnapshot,
  getCachedStatusResult,
  describeService,
  extractMapName,
  extractServerName,
  testToken,
  listAllServicesForGuild,
  tokenForServer,
  listFiles,
  downloadFileText,
  seekFileText,
  pathSize,
  getServiceLogs,
  listFileBookmarks,
  fetchGameLogText,
  pickGameLogFiles,
  scoreGameLogEntry,
  listSaves,
  listNitradoBackups,
  restoreSave,
  restoreNitradoBackup,
  uploadSave,
  uploadFileBinary,
  resolveSavedArksDir,
  inferActiveArkName,
  invalidateSaveListCache,
  getCachedSaveListMeta,
  formatBytes,
  SAVE_FILE_RE,
  is429,
  isRateLimited,
  isGlobalRateLimited,
  isGuildHeavyPollPaused,
  getGuildCooldownRemainingMs,
  getGlobalCooldownRemainingMs,
  markRateLimited,
  markGlobalRateLimited,
  GLOBAL_RATE_LIMIT_MS,
  STATUS_CACHE_TTL_MS,
  CLUSTER_SNAPSHOT_TTL_MS,
};

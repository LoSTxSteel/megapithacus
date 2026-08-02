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

async function listPlayers(serviceId, token) {
  try {
    const data = await apiGet(`/services/${serviceId}/gameservers/games/players`, token);
    return Array.isArray(data.players) ? data.players : [];
  } catch {
    return null;
  }
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
 */
async function queryService(server, token) {
  const auth = token || server.token;
  try {
    const [gameserver, players] = await Promise.all([
      getGameserver(server.serviceId, auth),
      listPlayers(server.serviceId, auth),
    ]);

    const online = isOnline(gameserver.status);
    const maxPlayers = Number(gameserver.slots || gameserver.query?.max_players || 0);

    let playerCount = 0;
    if (Array.isArray(players)) {
      playerCount = players.length;
    } else if (gameserver.query?.player_current != null) {
      playerCount = Number(gameserver.query.player_current);
    } else if (gameserver.query?.players != null) {
      playerCount = Number(gameserver.query.players);
    }

    const liveName = extractServerName(gameserver);
    return {
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
      playerNames: Array.isArray(players)
        ? players.map((p) => p.name || p.username || p.gamertag || String(p)).filter(Boolean)
        : [],
    };
  } catch (error) {
    return {
      ok: false,
      id: server.id,
      serviceId: server.serviceId,
      liveName: null,
      name: server.name,
      map: server.map || server.name,
      players: 0,
      maxPlayers: 0,
      status: 'error',
      online: false,
      error: error.message,
      playerNames: [],
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

async function queryCluster(servers, guild) {
  const results = await Promise.all(
    servers.map((server) => queryService(server, tokenForServer(server, guild)))
  );
  const online = results.filter((r) => r.online);
  const totalPlayers = results.reduce((sum, r) => sum + r.players, 0);
  const totalSlots = results.reduce((sum, r) => sum + (r.maxPlayers || 0), 0);

  return {
    results: results.sort((a, b) => b.players - a.players),
    totalPlayers,
    totalSlots,
    onlineMaps: online.length,
    totalMaps: results.length,
  };
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
  } catch {
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
const MAX_LOG_FILES = 4;

/** Warn once per service/file (or once per service for empty) — log boards poll often. */
const logWarnOnce = new Set();
function warnLogOnce(key, message) {
  if (logWarnOnce.has(key)) return;
  logWarnOnce.add(key);
  console.warn(message);
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
 */
async function readLogFileTail(serviceId, token, entry, baseDir) {
  const filePath = resolveLogPath(entry, baseDir);
  if (!filePath) {
    throw new NitradoError('Log entry has no path/name', 404);
  }

  let size = Number(entry.size || 0);
  if (!size || !Number.isFinite(size)) {
    size = await pathSize(serviceId, token, filePath);
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
    errors.push(`tail:${error.message}`);
  }

  // 2) Absolute offset when size is known.
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
      errors.push(`seek:${error.message}`);
    }
  }

  // 3) Full download last — often 404 for in-use ShooterGame.log on arkxb.
  try {
    return await downloadFileText(serviceId, token, filePath);
  } catch (error) {
    errors.push(`download:${error.message}`);
    throw new NitradoError(
      `Log read failed for ${filePath} (${errors.join(' | ')})`,
      error.status || 404
    );
  }
}

function logsDirCandidates(username, game, bookmarks = []) {
  const dirs = [];
  if (username && game) {
    dirs.push(`/games/${username}/noftp/${game}/ShooterGame/Saved/Logs`);
    dirs.push(`/games/${username}/noftp/${game}/ShooterGame/Saved/SaveGames/Logs`);
    // Some Xbox products expose Logs one level under Saved without nesting quirks.
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
 * Lists Logs dirs, prefers ServerGame.log, then tails existing files via seek.
 */
async function fetchGameLogText(serviceId, token) {
  const gameserver = await getGameserver(serviceId, token);
  const username = gameserver.username || gameserver.user_name;
  const game = gameserver.game;
  const chunks = [];
  const fetchedNames = [];
  let listError = null;
  let sawCandidates = false;

  const serviceLogs = await getServiceLogs(serviceId, token, 1);
  if (Array.isArray(serviceLogs) && serviceLogs.length) {
    chunks.push(
      serviceLogs
        .map((l) => l.message || l.text || l.content || JSON.stringify(l))
        .join('\n')
    );
  }

  const bookmarks = await listFileBookmarks(serviceId, token);
  const dirs = logsDirCandidates(username, game, bookmarks);
  const seenDirs = new Set();

  for (let i = 0; i < dirs.length; i += 1) {
    const base = dirs[i];
    const baseKey = base.toLowerCase();
    if (seenDirs.has(baseKey)) continue;
    seenDirs.add(baseKey);

    let entries;
    try {
      entries = await listFiles(serviceId, token, base);
    } catch (error) {
      listError = error.message;
      continue;
    }

    const inLogsDir = /\/Logs$/i.test(base);

    // Discover nested Logs/ when listing Saved/.
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

    // Only inject ServerGame/ShooterGame names under real Logs dirs (not Saved/).
    const merged = mergeLogEntries(entries, base, { injectKnown: inLogsDir });
    const targets = pickGameLogFiles(merged);
    if (!targets.length) continue;
    sawCandidates = true;

    for (const target of targets) {
      const label = target.name || entryBaseName(target) || 'log';
      try {
        const text = await readLogFileTail(serviceId, token, target, base);
        if (text && text.trim()) {
          chunks.push(text);
          fetchedNames.push(label);
        }
      } catch (error) {
        // Expected when a listed ShooterGame.log is locked/stale — try next candidate.
        const unexpected = error.status && error.status !== 404;
        warnLogOnce(
          `${serviceId}:${label}:${unexpected ? 'err' : '404'}`,
          `[nitrado] log read failed serviceId=${serviceId} file=${label}: ${error.message}`
        );
      }
    }

    // One successful Logs directory is enough
    if (fetchedNames.length) break;
  }

  if (!fetchedNames.length && (username || game)) {
    warnLogOnce(
      `${serviceId}:none`,
      `[nitrado] no ASE game logs found serviceId=${serviceId}` +
        ` username=${username || '?'} game=${game || '?'}` +
        (listError ? ` listError=${listError}` : '') +
        (sawCandidates ? ' (listed files but reads failed — often locked arkxb logs)' : '')
    );
  }

  return {
    gameserver,
    text: chunks.join('\n'),
    logFiles: fetchedNames,
  };
}

module.exports = {
  NitradoError,
  resolveToken,
  listServices,
  getGameserver,
  listPlayers,
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
  queryCluster,
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
};

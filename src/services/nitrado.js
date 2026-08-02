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

async function apiRequest(method, path, token, formFields = null) {
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

  if (formFields && Object.keys(formFields).length) {
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
 * Kick via Nitrado Player Management (preferred for arkxb / online players).
 * Official shape: GET .../games/players/{playerId}?type=kick
 * Uses the `id` from GET .../games/players — not gamertag, not specimen implant.
 */
async function kickOnlinePlayer(serviceId, token, playerId) {
  const id = encodeURIComponent(String(playerId).trim());
  const qs = new URLSearchParams({ type: 'kick' }).toString();
  try {
    return await apiGet(
      `/services/${serviceId}/gameservers/games/players/${id}?${qs}`,
      token
    );
  } catch (error) {
    // Some products accept POST /players/kick with player_id instead.
    if (error instanceof NitradoError && (error.status === 404 || error.status === 405)) {
      return apiPost(`/services/${serviceId}/gameservers/games/players/kick`, token, {
        player_id: String(playerId).trim(),
      });
    }
    throw error;
  }
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

  return (
    configBlock.map ||
    configBlock.Map ||
    configBlock.ServerMap ||
    general.map ||
    gameserver.query?.map ||
    gameserver.game_human ||
    fallback
  );
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

async function seekFileText(serviceId, token, filePath, offset = 0, length = 100000) {
  const params = new URLSearchParams({
    file: filePath,
    offset: String(offset),
    length: String(length),
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

/**
 * Score ASE game-log candidates.
 * AdminCmd / chat / join lines live in ServerGame*.log when -servergamelog is on;
 * ShooterGame.log is the UE log (sometimes also has chat). Prefer current files over
 * rotated ShooterGame_2.log archives (localeCompare sorting picked those wrongly).
 */
function scoreGameLogEntry(entry) {
  const name = String(entry?.name || entry?.path || '')
    .split(/[/\\]/)
    .pop()
    .toLowerCase();
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
    .filter((e) => e && e.type === 'file' && scoreGameLogEntry(e) > 0)
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

async function readLogFileTail(serviceId, token, entry, baseDir) {
  const filePath = entry.path || `${baseDir}/${entry.name}`;
  const size = Number(entry.size || 0);
  const offset = size > LOG_TAIL_BYTES ? size - LOG_TAIL_BYTES : 0;
  if (offset > 0) {
    return seekFileText(serviceId, token, filePath, offset, LOG_TAIL_BYTES);
  }
  return downloadFileText(serviceId, token, filePath);
}

function logsDirCandidates(username, game, bookmarks = []) {
  const dirs = [];
  if (username && game) {
    dirs.push(`/games/${username}/noftp/${game}/ShooterGame/Saved/Logs`);
    dirs.push(`/games/${username}/noftp/${game}/ShooterGame/Saved/SaveGames/Logs`);
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

/**
 * Best-effort ASE log text from a Nitrado service (Xbox / Microsoft Store).
 * Pulls ServerGame.log (AdminCmd + chat) and ShooterGame.log tails.
 */
async function fetchGameLogText(serviceId, token) {
  const gameserver = await getGameserver(serviceId, token);
  const username = gameserver.username || gameserver.user_name;
  const game = gameserver.game;
  const chunks = [];
  const fetchedNames = [];
  let listError = null;

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

  for (const base of dirs) {
    let entries;
    try {
      entries = await listFiles(serviceId, token, base);
    } catch (error) {
      listError = error.message;
      continue;
    }

    const targets = pickGameLogFiles(entries);
    if (!targets.length) continue;

    for (const target of targets) {
      const label = target.name || target.path || 'log';
      try {
        const text = await readLogFileTail(serviceId, token, target, base);
        if (text && text.trim()) {
          chunks.push(text);
          fetchedNames.push(label);
        }
      } catch (error) {
        console.warn(
          `[nitrado] log read failed serviceId=${serviceId} file=${label}: ${error.message}`
        );
      }
    }

    // One successful Logs directory is enough
    if (fetchedNames.length) break;
  }

  if (!fetchedNames.length && (username || game)) {
    console.warn(
      `[nitrado] no ASE game logs found serviceId=${serviceId}` +
        ` username=${username || '?'} game=${game || '?'}` +
        (listError ? ` listError=${listError}` : '')
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
  getServiceLogs,
  listFileBookmarks,
  fetchGameLogText,
  pickGameLogFiles,
  scoreGameLogEntry,
};

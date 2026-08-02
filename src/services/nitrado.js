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
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    options.body = new URLSearchParams(formFields).toString();
  }

  const res = await fetch(`${BASE}${path}`, options);

  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const apiMsg = body?.message || body?.data?.message;
    const msg = apiMsg
      ? `${apiMsg} (${res.status} ${method} ${path})`
      : `Nitrado API ${res.status} ${method} ${path}`;
    throw new NitradoError(msg, res.status);
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
 */
async function sendCommand(serviceId, token, command) {
  return apiPost(`/services/${serviceId}/gameservers/command`, token, {
    command: String(command),
  });
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
 * Update one gameserver setting (Nitrado POST /gameservers/settings).
 * category/key vary by game; ASE commonly uses general/server-name.
 */
async function updateGameserverSetting(serviceId, token, category, key, value) {
  return apiPost(`/services/${serviceId}/gameservers/settings`, token, {
    category: String(category),
    key: String(key),
    value: value == null ? '' : String(value),
  });
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

/**
 * Set in-game / panel server display name via Nitrado settings.
 * Resolves category/key from live settings when possible.
 */
async function setServerName(serviceId, token, name) {
  const gameserver = await getGameserver(serviceId, token);
  const settings = gameserver.settings || {};
  const match =
    findSettingKey(
      settings,
      (_cat, key) => /^server[-_]?name$/i.test(key) || /^hostname$/i.test(key)
    ) || { category: 'general', key: 'server-name' };

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
 * Resolves category/key from live settings when possible.
 */
async function setServerPassword(serviceId, token, password) {
  const gameserver = await getGameserver(serviceId, token);
  const settings = gameserver.settings || {};
  const match =
    findSettingKey(settings, (_cat, key) => {
      if (/admin/i.test(key)) return false;
      return (
        /^server[-_]?password$/i.test(key) ||
        /^password$/i.test(key) ||
        /^ServerPassword$/i.test(key)
      );
    }) || { category: 'general', key: 'server-password' };

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
 * Resolves category/key from live settings when possible.
 */
async function setAdminPassword(serviceId, token, password) {
  const gameserver = await getGameserver(serviceId, token);
  const settings = gameserver.settings || {};
  const match =
    findSettingKey(settings, (_cat, key) => {
      return (
        /admin[-_]?password/i.test(key) ||
        /^serveradminpassword$/i.test(key) ||
        /^AdminPassword$/i.test(key)
      );
    }) || { category: 'general', key: 'admin-password' };

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

    return {
      ok: true,
      id: server.id,
      serviceId: server.serviceId,
      name: server.name,
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

/**
 * Best-effort ASE log text from a Nitrado service (Xbox / Microsoft Store).
 */
async function fetchGameLogText(serviceId, token) {
  const gameserver = await getGameserver(serviceId, token);
  const username = gameserver.username || gameserver.user_name;
  const game = gameserver.game;
  const chunks = [];

  const serviceLogs = await getServiceLogs(serviceId, token, 1);
  if (Array.isArray(serviceLogs) && serviceLogs.length) {
    chunks.push(
      serviceLogs
        .map((l) => l.message || l.text || l.content || JSON.stringify(l))
        .join('\n')
    );
  }

  if (username && game) {
    const base = `/games/${username}/noftp/${game}/ShooterGame/Saved/Logs`;
    try {
      const entries = await listFiles(serviceId, token, base);
      const logFiles = entries
        .filter((e) => e.type === 'file' && /shootergame.*\.log$/i.test(e.name || e.path || ''))
        .sort((a, b) => String(b.name || b.path).localeCompare(String(a.name || a.path)));

      const target = logFiles[0];
      if (target) {
        const filePath = target.path || `${base}/${target.name}`;
        try {
          const size = Number(target.size || 0);
          const offset = size > 120000 ? size - 120000 : 0;
          const text =
            offset > 0
              ? await seekFileText(serviceId, token, filePath, offset, 120000)
              : await downloadFileText(serviceId, token, filePath);
          chunks.push(text);
        } catch {
          // ignore single-file failures
        }
      }
    } catch {
      // Logs folder may be unavailable on some Xbox products
    }
  }

  return {
    gameserver,
    text: chunks.join('\n'),
  };
}

module.exports = {
  NitradoError,
  resolveToken,
  listServices,
  getGameserver,
  listPlayers,
  addBanlist,
  removeBanlist,
  sendCommand,
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
  testToken,
  listAllServicesForGuild,
  tokenForServer,
  listFiles,
  downloadFileText,
  seekFileText,
  getServiceLogs,
  fetchGameLogText,
};

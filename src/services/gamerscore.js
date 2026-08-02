const config = require('../config');

/** @type {Map<string, { score: number|null, error: string|null, at: number }>} */
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

/** OpenXBL: api.xbl.io uses /v2/… ; xbl.io uses /api/v2/… */
const OPENXBL_BASES = [
  { host: 'https://api.xbl.io', prefix: '/v2' },
  { host: 'https://xbl.io', prefix: '/api/v2' },
];

function apiKey() {
  return (
    config.openxblApiKey ||
    process.env.OPENXBL_API_KEY ||
    process.env.XBOX_API_KEY ||
    null
  );
}

function hasApiKey() {
  return Boolean(apiKey());
}

function cacheKey(gamertag) {
  return String(gamertag || '')
    .trim()
    .toLowerCase();
}

function parseScore(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

/** OpenXBL wraps most payloads as `{ content: … }`. */
function unwrapPayload(data) {
  if (data == null || typeof data !== 'object') return data;
  if (data.content != null && typeof data.content === 'object') {
    return data.content;
  }
  return data;
}

function extractGamerscore(data) {
  const root = unwrapPayload(data);
  if (root == null || typeof root !== 'object') return null;

  const direct = parseScore(
    root.gamerscore ?? root.Gamerscore ?? root.gamerScore ?? root.gamer_score
  );
  if (direct != null) return direct;

  const lists = [
    root.profileUsers,
    root.people,
    root.profiles,
    root.results,
    Array.isArray(root) ? root : null,
  ]
    .filter(Array.isArray)
    .flat();

  for (const user of lists) {
    if (!user || typeof user !== 'object') continue;

    const nested = parseScore(
      user.gamerscore ??
        user.Gamerscore ??
        user.gamerScore ??
        user.gamer_score
    );
    if (nested != null) return nested;

    const settings = user.settings || user.profileSettings || [];
    if (Array.isArray(settings)) {
      const gs = settings.find(
        (s) => String(s?.id || s?.name || '').toLowerCase() === 'gamerscore'
      );
      const fromSettings = parseScore(gs?.value);
      if (fromSettings != null) return fromSettings;
    }
  }

  return null;
}

function extractXuid(data) {
  const root = unwrapPayload(data);
  if (root == null || typeof root !== 'object') return null;

  if (root.xuid != null && String(root.xuid).trim()) {
    return String(root.xuid).trim();
  }

  const lists = [root.people, root.profileUsers, root.profiles, root.results]
    .filter(Array.isArray)
    .flat();

  for (const user of lists) {
    if (!user || typeof user !== 'object') continue;
    const id = user.xuid ?? user.id ?? user.hostId;
    if (id != null && String(id).trim() && /^\d{5,}$/.test(String(id).trim())) {
      return String(id).trim();
    }
  }
  return null;
}

const OPENXBL_TIMEOUT_MS = 8_000;

async function fetchOpenXbl(url, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENXBL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'X-Authorization': key,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { res, json };
  } finally {
    clearTimeout(timer);
  }
}

function lookupUrls(gamertag) {
  const encoded = encodeURIComponent(gamertag);
  const urls = [];
  for (const { host, prefix } of OPENXBL_BASES) {
    // Search by gamertag (includes gamerScore on people hub)
    urls.push(`${host}${prefix}/search/${encoded}`);
    // Friends/people search — returns profileUsers with Gamerscore settings
    urls.push(`${host}${prefix}/friends/search?gt=${encoded}`);
    urls.push(`${host}${prefix}/friends/search/${encoded}`);
  }
  return urls;
}

function accountUrls(xuid) {
  const id = encodeURIComponent(String(xuid).trim());
  return OPENXBL_BASES.map(
    ({ host, prefix }) => `${host}${prefix}/account/${id}`
  );
}

/**
 * Look up Xbox gamerscore for a Microsoft Store / Xbox gamertag via OpenXBL.
 * Cached ~10 minutes per gamertag.
 *
 * @returns {Promise<{ ok: boolean, gamerscore: number|null, gamertag: string, cached: boolean, error?: string }>}
 */
async function getGamerscore(gamertag) {
  const clean = String(gamertag || '').trim();
  if (!clean) {
    return {
      ok: false,
      gamerscore: null,
      gamertag: '',
      cached: false,
      error: 'No gamertag',
    };
  }

  const key = cacheKey(clean);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    if (hit.error) {
      return {
        ok: false,
        gamerscore: null,
        gamertag: clean,
        cached: true,
        error: hit.error,
      };
    }
    return {
      ok: true,
      gamerscore: hit.score,
      gamertag: clean,
      cached: true,
    };
  }

  const auth = apiKey();
  if (!auth) {
    const error =
      'OPENXBL_API_KEY is not set. Get a free key at https://xbl.io and add it to the bot env.';
    cache.set(key, { score: null, error, at: Date.now() });
    return { ok: false, gamerscore: null, gamertag: clean, cached: false, error };
  }

  let lastError = 'Xbox API request failed';
  let foundXuid = null;

  for (const url of lookupUrls(clean)) {
    try {
      const { res, json } = await fetchOpenXbl(url, auth);
      if (res.status === 401 || res.status === 403) {
        lastError = 'OpenXBL API key rejected (401/403). Check OPENXBL_API_KEY.';
        break;
      }
      if (res.status === 429) {
        lastError = 'OpenXBL rate limit hit. Try again later.';
        break;
      }
      if (!res.ok) {
        lastError = `OpenXBL HTTP ${res.status}`;
        continue;
      }

      // Soft upstream failures sometimes return HTTP 200 with code 503
      if (json?.code && Number(json.code) >= 400) {
        lastError = `OpenXBL upstream ${json.code}`;
        continue;
      }

      const score = extractGamerscore(json);
      if (score != null) {
        cache.set(key, { score, error: null, at: Date.now() });
        return { ok: true, gamerscore: score, gamertag: clean, cached: false };
      }

      const xuid = extractXuid(json);
      if (xuid && !foundXuid) foundXuid = xuid;
      lastError = 'Profile found but gamerscore missing from response';
    } catch (error) {
      lastError = error.message || 'Network error talking to OpenXBL';
    }
  }

  // Fallback: resolve XUID then GET /account/{xuid}
  if (foundXuid) {
    for (const url of accountUrls(foundXuid)) {
      try {
        const { res, json } = await fetchOpenXbl(url, auth);
        if (res.status === 401 || res.status === 403) {
          lastError = 'OpenXBL API key rejected (401/403). Check OPENXBL_API_KEY.';
          break;
        }
        if (!res.ok) {
          lastError = `OpenXBL HTTP ${res.status}`;
          continue;
        }
        const score = extractGamerscore(json);
        if (score != null) {
          cache.set(key, { score, error: null, at: Date.now() });
          return { ok: true, gamerscore: score, gamertag: clean, cached: false };
        }
      } catch (error) {
        lastError = error.message || 'Network error talking to OpenXBL';
      }
    }
  }

  cache.set(key, { score: null, error: lastError, at: Date.now() });
  return {
    ok: false,
    gamerscore: null,
    gamertag: clean,
    cached: false,
    error: lastError,
  };
}

/**
 * Evaluate a player against the configured minimum.
 * Fail-open: unverified lookups never fail the threshold check.
 */
function evaluateThreshold(gamerscore, minScore) {
  const min = Math.max(0, Number(minScore) || 0);
  if (gamerscore == null || !Number.isFinite(Number(gamerscore))) {
    return { pass: true, verified: false, minScore: min };
  }
  const score = Number(gamerscore);
  return {
    pass: score >= min,
    verified: true,
    minScore: min,
    gamerscore: score,
  };
}

function clearGamerscoreCache() {
  cache.clear();
}

module.exports = {
  getGamerscore,
  evaluateThreshold,
  hasApiKey,
  clearGamerscoreCache,
  CACHE_TTL_MS,
  extractGamerscore,
  unwrapPayload,
};

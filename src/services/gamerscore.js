const config = require('../config');

/** @type {Map<string, { score: number|null, error: string|null, at: number }>} */
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

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

function extractGamerscore(data) {
  if (data == null || typeof data !== 'object') return null;

  const direct = parseScore(data.gamerscore ?? data.Gamerscore ?? data.gamerScore);
  if (direct != null) return direct;

  const lists = [data.profileUsers, data.people, data.profiles, data.results]
    .filter(Array.isArray)
    .flat();

  for (const user of lists) {
    if (!user || typeof user !== 'object') continue;

    const nested = parseScore(
      user.gamerscore ?? user.Gamerscore ?? user.gamerScore
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

async function fetchOpenXbl(url, key) {
  const res = await fetch(url, {
    headers: {
      'X-Authorization': key,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, json };
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

  const encoded = encodeURIComponent(clean);
  const endpoints = [
    `https://xbl.io/api/v2/player/gamertag/${encoded}`,
    `https://api.xbl.io/api/v2/player/gamertag/${encoded}`,
    `https://xbl.io/api/v2/search/${encoded}`,
    `https://xbl.io/api/v2/friends/search?gt=${encoded}`,
  ];

  let lastError = 'Xbox API request failed';

  for (const url of endpoints) {
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
      const score = extractGamerscore(json);
      if (score == null) {
        lastError = 'Profile found but gamerscore missing from response';
        continue;
      }
      cache.set(key, { score, error: null, at: Date.now() });
      return { ok: true, gamerscore: score, gamertag: clean, cached: false };
    } catch (error) {
      lastError = error.message || 'Network error talking to OpenXBL';
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
};

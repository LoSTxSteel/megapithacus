const config = require('../config');

/**
 * Shared OpenXBL cache (gamerscore + official Xbox gamertag).
 * @type {Map<string, { score: number|null, xboxGamertag: string|null, xuid: string|null, error: string|null, at: number }>}
 */
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

function pickGamertagString(...values) {
  for (const v of values) {
    if (v == null) continue;
    const s = String(v).trim();
    if (!s) continue;
    // Skip pure numeric ids mistaken for names
    if (/^\d{5,}$/.test(s)) continue;
    return s;
  }
  return null;
}

function gamertagFromSettings(settings) {
  if (!Array.isArray(settings)) return null;
  const hit = settings.find((s) => {
    const id = String(s?.id || s?.name || '').toLowerCase();
    return (
      id === 'gamertag' ||
      id === 'moderngamertag' ||
      id === 'uniquegamertag' ||
      id === 'unique_modern_gamertag'
    );
  });
  return pickGamertagString(hit?.value);
}

/**
 * Official Xbox Live gamertag from an OpenXBL profile / search payload.
 */
function extractGamertag(data) {
  const root = unwrapPayload(data);
  if (root == null || typeof root !== 'object') return null;

  const direct = pickGamertagString(
    root.modernGamertag,
    root.uniqueModernGamertag,
    root.gamertag,
    root.uniqueGamertag,
    root.displayName,
    root.GameDisplayName
  );
  if (direct) return direct;

  const fromRootSettings = gamertagFromSettings(
    root.settings || root.profileSettings
  );
  if (fromRootSettings) return fromRootSettings;

  const lists = [
    root.people,
    root.profileUsers,
    root.profiles,
    root.results,
    Array.isArray(root) ? root : null,
  ]
    .filter(Array.isArray)
    .flat();

  for (const user of lists) {
    if (!user || typeof user !== 'object') continue;
    const nested = pickGamertagString(
      user.modernGamertag,
      user.uniqueModernGamertag,
      user.gamertag,
      user.uniqueGamertag,
      user.displayName,
      user.GameDisplayName
    );
    if (nested) return nested;

    const fromSettings = gamertagFromSettings(
      user.settings || user.profileSettings
    );
    if (fromSettings) return fromSettings;
  }

  return null;
}

function looksLikeXuid(value) {
  const s = String(value || '').trim();
  return /^\d{15,20}$/.test(s);
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at >= CACHE_TTL_MS) return null;
  return hit;
}

function cacheSet(key, partial) {
  cache.set(key, {
    score: partial.score ?? null,
    xboxGamertag: partial.xboxGamertag ?? null,
    xuid: partial.xuid ?? null,
    error: partial.error ?? null,
    at: Date.now(),
  });
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
 * Resolve Xbox Live profile (official gamertag + optional score) via OpenXBL.
 * Prefer XUID when available; otherwise search by displayed gamertag.
 * Cached ~10 minutes per query key (shared with getGamerscore).
 *
 * @param {{ gamertag?: string|null, xuid?: string|null }} query
 * @returns {Promise<{ ok: boolean, xboxGamertag: string|null, xuid: string|null, gamerscore: number|null, query: string, cached: boolean, error?: string }>}
 */
async function getXboxProfile(query = {}) {
  const xuidIn = looksLikeXuid(query.xuid) ? String(query.xuid).trim() : null;
  const gtIn = String(query.gamertag || '').trim();
  const queryLabel = xuidIn || gtIn;

  if (!queryLabel) {
    return {
      ok: false,
      xboxGamertag: null,
      xuid: null,
      gamerscore: null,
      query: '',
      cached: false,
      error: 'No gamertag or XUID',
    };
  }

  const key = cacheKey(xuidIn ? `xuid:${xuidIn}` : gtIn);
  const hit = cacheGet(key);
  if (hit) {
    if (hit.error && !hit.xboxGamertag && hit.score == null) {
      return {
        ok: false,
        xboxGamertag: null,
        xuid: hit.xuid || xuidIn,
        gamerscore: null,
        query: queryLabel,
        cached: true,
        error: hit.error,
      };
    }
    if (hit.xboxGamertag || hit.score != null) {
      return {
        ok: Boolean(hit.xboxGamertag) || hit.score != null,
        xboxGamertag: hit.xboxGamertag,
        xuid: hit.xuid || xuidIn,
        gamerscore: hit.score,
        query: queryLabel,
        cached: true,
        error: hit.xboxGamertag ? undefined : hit.error || undefined,
      };
    }
  }

  // Reuse gamertag-keyed cache when looking up by displayed name
  if (!xuidIn && gtIn) {
    const byGt = cacheGet(cacheKey(gtIn));
    if (byGt?.xboxGamertag || byGt?.score != null) {
      return {
        ok: Boolean(byGt.xboxGamertag) || byGt.score != null,
        xboxGamertag: byGt.xboxGamertag,
        xuid: byGt.xuid,
        gamerscore: byGt.score,
        query: queryLabel,
        cached: true,
      };
    }
  }

  const auth = apiKey();
  if (!auth) {
    const error =
      'OPENXBL_API_KEY is not set. Get a free key at https://xbl.io and add it to the bot env.';
    cacheSet(key, { score: null, xboxGamertag: null, xuid: xuidIn, error });
    return {
      ok: false,
      xboxGamertag: null,
      xuid: xuidIn,
      gamerscore: null,
      query: queryLabel,
      cached: false,
      error,
    };
  }

  let lastError = 'Xbox API request failed';
  let foundXuid = xuidIn;
  let foundTag = null;
  let foundScore = null;

  const tryJson = (json) => {
    const score = extractGamerscore(json);
    const tag = extractGamertag(json);
    const xuid = extractXuid(json);
    if (score != null) foundScore = score;
    if (tag) foundTag = tag;
    if (xuid && !foundXuid) foundXuid = xuid;
    return score != null || Boolean(tag);
  };

  const urls = xuidIn
    ? accountUrls(xuidIn)
    : lookupUrls(gtIn);

  for (const url of urls) {
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
      if (json?.code && Number(json.code) >= 400) {
        lastError = `OpenXBL upstream ${json.code}`;
        continue;
      }

      if (tryJson(json) && (foundTag || foundScore != null)) {
        const entry = {
          score: foundScore,
          xboxGamertag: foundTag,
          xuid: foundXuid,
          error: foundTag || foundScore != null ? null : lastError,
        };
        cacheSet(key, entry);
        if (gtIn) cacheSet(cacheKey(gtIn), entry);
        if (foundXuid) cacheSet(cacheKey(`xuid:${foundXuid}`), entry);
        // Prefer resolving official tag via account when search only yielded score
        if (foundTag || (foundScore != null && xuidIn)) {
          return {
            ok: true,
            xboxGamertag: foundTag,
            xuid: foundXuid,
            gamerscore: foundScore,
            query: queryLabel,
            cached: false,
          };
        }
      }
      lastError = foundXuid
        ? 'Profile found but Xbox gamertag missing from response'
        : 'No matching Xbox profile';
    } catch (error) {
      lastError = error.message || 'Network error talking to OpenXBL';
    }
  }

  // Search found XUID but not tag — resolve account for official gamertag
  if (foundXuid && !foundTag) {
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
        tryJson(json);
        if (foundTag || foundScore != null) {
          const entry = {
            score: foundScore,
            xboxGamertag: foundTag,
            xuid: foundXuid,
            error: foundTag ? null : lastError,
          };
          cacheSet(key, entry);
          if (gtIn) cacheSet(cacheKey(gtIn), entry);
          cacheSet(cacheKey(`xuid:${foundXuid}`), entry);
          return {
            ok: Boolean(foundTag) || foundScore != null,
            xboxGamertag: foundTag,
            xuid: foundXuid,
            gamerscore: foundScore,
            query: queryLabel,
            cached: false,
            error: foundTag ? undefined : lastError,
          };
        }
      } catch (error) {
        lastError = error.message || 'Network error talking to OpenXBL';
      }
    }
  }

  // Score-only success (gamerscore path) when account tag never appeared
  if (foundScore != null) {
    const entry = {
      score: foundScore,
      xboxGamertag: foundTag,
      xuid: foundXuid,
      error: null,
    };
    cacheSet(key, entry);
    if (gtIn) cacheSet(cacheKey(gtIn), entry);
    if (foundXuid) cacheSet(cacheKey(`xuid:${foundXuid}`), entry);
    return {
      ok: true,
      xboxGamertag: foundTag,
      xuid: foundXuid,
      gamerscore: foundScore,
      query: queryLabel,
      cached: false,
    };
  }

  cacheSet(key, {
    score: foundScore,
    xboxGamertag: foundTag,
    xuid: foundXuid,
    error: lastError,
  });
  return {
    ok: false,
    xboxGamertag: foundTag,
    xuid: foundXuid,
    gamerscore: foundScore,
    query: queryLabel,
    cached: false,
    error: lastError,
  };
}

/**
 * Look up Xbox gamerscore for a Microsoft Store / Xbox gamertag via OpenXBL.
 * Cached ~10 minutes per gamertag (shared with getXboxProfile).
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

  const profile = await getXboxProfile({ gamertag: clean });
  if (profile.gamerscore != null && Number.isFinite(Number(profile.gamerscore))) {
    return {
      ok: true,
      gamerscore: Number(profile.gamerscore),
      gamertag: clean,
      cached: Boolean(profile.cached),
    };
  }

  return {
    ok: false,
    gamerscore: null,
    gamertag: clean,
    cached: Boolean(profile.cached),
    error: profile.error || 'null-score',
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
  getXboxProfile,
  evaluateThreshold,
  hasApiKey,
  clearGamerscoreCache,
  CACHE_TTL_MS,
  extractGamerscore,
  extractGamertag,
  extractXuid,
  looksLikeXuid,
  unwrapPayload,
};

/**
 * Normalize raw Nitrado / ASE map identifiers into friendly display names.
 *
 * Examples:
 *   preinstalled,1,island      → The Island
 *   TheIsland_WP               → The Island
 *   Ragnarok_WP                → Ragnarok
 *   preinstalled,1,aberration  → Aberration
 */

const ASE_MAP_NAMES = {
  island: 'The Island',
  theisland: 'The Island',
  theisland_wp: 'The Island',
  theisland_p: 'The Island',
  ragnarok: 'Ragnarok',
  ragnarok_wp: 'Ragnarok',
  ragnarok_p: 'Ragnarok',
  valguero: 'Valguero',
  valguero_wp: 'Valguero',
  valguero_p: 'Valguero',
  crystalisles: 'Crystal Isles',
  crystalisles_wp: 'Crystal Isles',
  crystalisles_p: 'Crystal Isles',
  genesis: 'Genesis',
  genesis_wp: 'Genesis',
  genesis_p: 'Genesis',
  genesis1: 'Genesis',
  gen1: 'Genesis',
  genesis2: 'Genesis 2',
  genesis2_wp: 'Genesis 2',
  genesis2_p: 'Genesis 2',
  gen2: 'Genesis 2',
  lostisland: 'Lost Island',
  lostisland_wp: 'Lost Island',
  lostisland_p: 'Lost Island',
  fjordur: 'Fjordur',
  fjordur_wp: 'Fjordur',
  fjordur_p: 'Fjordur',
  scorchedearth: 'Scorched Earth',
  scorchedearth_p: 'Scorched Earth',
  scorchedearth_wp: 'Scorched Earth',
  aberration: 'Aberration',
  aberration_p: 'Aberration',
  aberration_wp: 'Aberration',
  extinction: 'Extinction',
  extinction_p: 'Extinction',
  extinction_wp: 'Extinction',
  thecenter: 'The Center',
  thecenter_wp: 'The Center',
  thecenter_p: 'The Center',
  center: 'The Center',
  svartalfheim: 'Svartalfheim',
  olympus: 'Olympus',
};

/** Strip Nitrado install prefixes and ASA/ASE map suffixes. */
function stripMapNoise(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';

  // preinstalled,1,island  /  preinstalled,0,ragnarok
  s = s.replace(/^preinstalled\s*,\s*\d+\s*,\s*/i, '');
  // modded,12345,SomeMap
  s = s.replace(/^(?:modded|official|custom)\s*,\s*[^,]+\s*,\s*/i, '');
  // Take last comma segment if still CSV-like
  if (s.includes(',')) {
    const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length) s = parts[parts.length - 1];
  }

  // Drop path / URL noise
  s = s.replace(/^.*[\\/]/, '');
  // Drop UE map suffixes commonly seen on Nitrado
  s = s.replace(/_(?:WP|P|GameMode)$/i, '');

  return s.trim();
}

function lookupKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

/**
 * @param {unknown} raw
 * @param {string} [fallback='—']
 * @returns {string}
 */
function formatMapName(raw, fallback = '—') {
  if (raw == null || String(raw).trim() === '') return fallback;

  const original = String(raw).trim();
  const cleaned = stripMapNoise(original);
  if (!cleaned) return fallback;

  const key = lookupKey(cleaned);
  if (ASE_MAP_NAMES[key]) return ASE_MAP_NAMES[key];

  // Retry without trailing digits (e.g. Island2)
  const noDigits = key.replace(/\d+$/, '');
  if (noDigits && ASE_MAP_NAMES[noDigits]) return ASE_MAP_NAMES[noDigits];

  // Title-case leftover codes: LostIsland → Lost Island when spaced by camelCase
  const spaced = cleaned
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (spaced) {
    const spacedKey = lookupKey(spaced);
    if (ASE_MAP_NAMES[spacedKey]) return ASE_MAP_NAMES[spacedKey];
    return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return original;
}

module.exports = {
  formatMapName,
  stripMapNoise,
  ASE_MAP_NAMES,
};

const { EmbedBuilder } = require('discord.js');
const { getGuild, updateGuild, normalizeGamertag } = require('./storage');
const {
  isFeatureEnabled,
  isFeatureConfigured,
} = require('./featureSetup');
const {
  getXboxProfile,
  hasApiKey,
  looksLikeXuid,
} = require('./gamerscore');
const { brandEmbed } = require('../utils/embeds');

/** Warn once per guild/reason for quiet fail-open skips. */
const failOpenWarned = new Set();

function warnFailOpenOnce(guildId, reason, detail) {
  const key = `${guildId}:${reason}`;
  if (failOpenWarned.has(key)) return;
  failOpenWarned.add(key);
  console.warn(`[spoof] fail-open guild=${guildId} ${reason}: ${detail}`);
}

/**
 * Normalize for comparison: trim, collapse spaces, case-insensitive.
 * Also treat space-stripped forms as equal (Xbox modern vs spaced tags).
 */
function normalizeCompare(name) {
  return String(name || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function namesMatch(displayed, xboxGamertag) {
  const a = normalizeCompare(displayed);
  const b = normalizeCompare(xboxGamertag);
  if (!a || !b) return false;
  if (a === b) return true;
  // Soft match: ignore internal spaces (Kenny Cool ↔ KennyCool)
  if (a.replace(/\s+/g, '') === b.replace(/\s+/g, '')) return true;
  return false;
}

/**
 * Stable identity keys — prefer platform / nitrado ids, then gamertag.
 */
function spoofIdentityKeys(profile) {
  const keys = [];
  const pid = profile?.platformId ? String(profile.platformId).trim() : '';
  if (pid) keys.push(`pid:${pid}`);
  const nid = profile?.nitradoPlayerId
    ? String(profile.nitradoPlayerId).trim()
    : '';
  if (nid) keys.push(`nid:${nid}`);
  const gt = normalizeGamertag(profile?.gamertag || '').toLowerCase();
  if (gt) keys.push(`gt:${gt}`);
  return keys;
}

function checkedPlayersMap(guildId) {
  const guild = getGuild(guildId);
  const map = guild.spoofDetection?.checkedPlayers;
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
}

/**
 * Skip if this identity was already checked for the same displayed name.
 * Re-check when the Nitrado / in-game displayed name changes.
 */
function isSpoofChecked(guildId, profile, displayedName) {
  const map = checkedPlayersMap(guildId);
  const keys = spoofIdentityKeys(profile);
  if (!keys.length) return false;
  const displayed = normalizeCompare(displayedName);
  return keys.some((k) => {
    const entry = map[k];
    if (!entry) return false;
    if (typeof entry === 'string') {
      // Legacy: timestamp-only — treat as checked for any name
      return true;
    }
    if (typeof entry === 'object') {
      return normalizeCompare(entry.displayed) === displayed;
    }
    return false;
  });
}

function markSpoofChecked(guildId, profile, displayedName, { mismatch = false } = {}) {
  const keys = spoofIdentityKeys(profile);
  if (!keys.length) return false;
  const prev = checkedPlayersMap(guildId);
  const next = { ...prev };
  const now = new Date().toISOString();
  const displayed = normalizeCompare(displayedName);
  let changed = false;
  for (const k of keys) {
    const existing = next[k];
    const same =
      existing &&
      typeof existing === 'object' &&
      normalizeCompare(existing.displayed) === displayed;
    if (!same) {
      next[k] = { displayed, mismatch: Boolean(mismatch), at: now };
      changed = true;
    }
  }
  if (!changed) return false;
  updateGuild(guildId, {
    spoofDetection: { checkedPlayers: next },
  });
  return true;
}

async function postSetupReadyEmbed(discordGuild, guildId) {
  const guild = getGuild(guildId);
  const channelId = guild.featureSetup?.spoofDetection?.channelId;
  if (!channelId) return { ok: false, error: 'No log channel' };

  const channel = await discordGuild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return { ok: false, error: 'Log channel missing' };

  const embed = brandEmbed(
    new EmbedBuilder()
      .setTitle('Spoof Detection ready')
      .setColor(0x9b59b6)
      .setDescription(
        [
          'This feature is **set up and working**.',
          'When a player joins a map, Megapithacus compares the **Nitrado / in-game displayed name** to the **official Xbox Live gamertag** (OpenXBL).',
          '',
          'Mismatches are flagged here. Matches and API failures are quiet (fail-open — no punishment).',
        ].join('\n')
      ),
    guild,
    { context: 'Spoof detection' }
  );

  await channel.send({ embeds: [embed] });
  return { ok: true };
}

async function postSpoofFlag(discordGuild, guildId, fields) {
  const guild = getGuild(guildId);
  const channelId = guild.featureSetup?.spoofDetection?.channelId;
  if (!channelId) return { ok: false, error: 'No log channel' };

  const channel = await discordGuild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return { ok: false, error: 'Log channel missing' };

  const embed = brandEmbed(
    new EmbedBuilder()
      .setTitle('Gamertag spoof / name mismatch')
      .setColor(0x9b59b6)
      .setDescription(
        'Displayed name on the map does **not** match the Xbox Live account gamertag.'
      )
      .addFields(
        {
          name: 'Displayed (Nitrado / in-game)',
          value: fields.displayedName || '—',
          inline: true,
        },
        {
          name: 'Xbox Live gamertag',
          value: fields.xboxGamertag || '—',
          inline: true,
        },
        {
          name: 'Map / server',
          value: fields.mapServer || '—',
          inline: true,
        },
        {
          name: 'Platform / XUID',
          value: fields.platformId ? `\`${fields.platformId}\`` : '—',
          inline: true,
        },
        {
          name: 'Nitrado player id',
          value: fields.nitradoPlayerId
            ? `\`${fields.nitradoPlayerId}\``
            : '—',
          inline: true,
        },
        {
          name: 'Character / IGN',
          value: fields.characterName || '—',
          inline: true,
        }
      ),
    guild,
    { context: 'Spoof detection' }
  );

  await channel.send({ embeds: [embed] });
  return { ok: true };
}

/**
 * Join-time spoof check. Fail-open on API / missing data — never punishes.
 */
async function handleSpoofJoin(discordGuild, guildId, {
  profile,
  mapName,
  serverName,
  serviceId,
}) {
  const guild = getGuild(guildId);
  if (
    !isFeatureEnabled(guild, 'spoofDetection') ||
    !isFeatureConfigured(guild, 'spoofDetection')
  ) {
    return { skipped: true, reason: 'disabled' };
  }

  const displayedName = profile?.gamertag
    ? String(profile.gamertag).trim()
    : null;
  if (!displayedName) {
    // Nothing to compare — quiet skip, do not mark (may get a name later)
    return { skipped: true, reason: 'no-displayed-name' };
  }

  if (isSpoofChecked(guildId, profile, displayedName)) {
    return { skipped: true, reason: 'already-checked' };
  }

  const mapServer =
    [mapName || profile?.map, serverName].filter(Boolean).join(' · ') ||
    String(serviceId || '—');
  const platformId = profile?.platformId
    ? String(profile.platformId).trim()
    : null;
  const xuid = looksLikeXuid(platformId) ? platformId : null;

  if (!hasApiKey()) {
    warnFailOpenOnce(
      guildId,
      'no-api-key',
      'OPENXBL_API_KEY missing — spoof checks skipped'
    );
    markSpoofChecked(guildId, profile, displayedName, { mismatch: false });
    return { skipped: true, reason: 'no-api-key' };
  }

  console.log(
    `[spoof] check start guild=${guildId} displayed=${displayedName} ` +
      `xuid=${xuid || '(none)'} serviceId=${serviceId || '(none)'}`
  );

  const lookup = await getXboxProfile({
    gamertag: displayedName,
    xuid,
  });

  if (!lookup.ok || !lookup.xboxGamertag) {
    warnFailOpenOnce(
      guildId,
      'lookup-failed',
      lookup.error || 'no xbox gamertag in response'
    );
    // Fail-open: mark checked so we don't spam OpenXBL every poll
    markSpoofChecked(guildId, profile, displayedName, { mismatch: false });
    console.log(
      `[spoof] fail-open displayed=${displayedName} cached=${Boolean(lookup.cached)} ` +
        `err=${lookup.error || 'no-tag'}`
    );
    return {
      skipped: true,
      reason: 'lookup-failed',
      error: lookup.error,
    };
  }

  const xboxGamertag = String(lookup.xboxGamertag).trim();
  const match = namesMatch(displayedName, xboxGamertag);

  markSpoofChecked(guildId, profile, displayedName, { mismatch: !match });

  if (match) {
    console.log(
      `[spoof] match displayed=${displayedName} xbox=${xboxGamertag} ` +
        `cached=${Boolean(lookup.cached)}`
    );
    return { ok: true, match: true, xboxGamertag };
  }

  console.log(
    `[spoof] MISMATCH displayed=${displayedName} xbox=${xboxGamertag} ` +
      `cached=${Boolean(lookup.cached)}`
  );

  await postSpoofFlag(discordGuild, guildId, {
    displayedName,
    xboxGamertag,
    mapServer,
    platformId: platformId || lookup.xuid || null,
    nitradoPlayerId: profile?.nitradoPlayerId
      ? String(profile.nitradoPlayerId).trim()
      : null,
    characterName: profile?.characterName
      ? String(profile.characterName).trim()
      : null,
  }).catch((err) => console.warn('[spoof] flag log failed:', err.message));

  return {
    ok: true,
    match: false,
    mismatch: true,
    displayedName,
    xboxGamertag,
  };
}

module.exports = {
  handleSpoofJoin,
  isSpoofChecked,
  markSpoofChecked,
  spoofIdentityKeys,
  namesMatch,
  normalizeCompare,
  postSetupReadyEmbed,
  postSpoofFlag,
};

const { EmbedBuilder } = require('discord.js');
const { getGuild } = require('./storage');
const {
  isFeatureEnabled,
  isFeatureConfigured,
} = require('./featureSetup');
const { getGamerscore, evaluateThreshold, hasApiKey } = require('./gamerscore');
const { moderatePlayer } = require('./playerModeration');
const { brandEmbed } = require('../utils/embeds');

function settingsFor(guild) {
  const s = guild.gamerscoreDetection || {};
  return {
    minScore: Math.max(0, Number(s.minScore) || 0),
    punishment: s.punishment === 'ban' ? 'ban' : 'kick',
    durationMinutes: Math.max(0, Number(s.durationMinutes) || 0),
    logPasses: Boolean(s.logPasses),
  };
}

function formatBanDuration(minutes) {
  const m = Math.max(0, Math.floor(Number(minutes) || 0));
  if (m <= 0) return null;
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  if (m % 1440 === 0) {
    const days = m / 1440;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (m % 60 === 0) {
    const hours = m / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${m} minutes`;
}

function punishmentSummary(settings) {
  if (settings.punishment === 'ban') {
    const duration = formatBanDuration(settings.durationMinutes);
    return duration ? `temp ban (${duration})` : 'permanent ban';
  }
  return 'kick';
}

/** Member-facing explanation of when / how long punishment applies. */
function punishmentTimingText(settings) {
  if (settings.punishment === 'ban') {
    const duration = formatBanDuration(settings.durationMinutes);
    if (!duration) {
      return 'Players below the minimum will be **permanently banned** when they join a map.';
    }
    return `Players below the minimum will be **banned for ${duration}** when they join a map.`;
  }
  return 'Players below the minimum will be **kicked immediately** when they join a map.';
}

/**
 * Post a one-shot “feature is set up and working” embed to #gamerscore-detection.
 */
async function postSetupReadyEmbed(discordGuild, guildId) {
  const guild = getGuild(guildId);
  const channelId = guild.featureSetup?.gamerscoreDetection?.channelId;
  if (!channelId) return { ok: false, error: 'No log channel' };

  const channel = await discordGuild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return { ok: false, error: 'Log channel missing' };

  const settings = settingsFor(guild);
  const embed = brandEmbed(
    new EmbedBuilder()
      .setTitle('Gamerscore Detection ready')
      .setColor(0x2ecc71)
      .setDescription(
        [
          'This feature is **set up and working**.',
          'Xbox gamerscore is checked when players join a map.',
          '',
          punishmentTimingText(settings),
        ].join('\n')
      )
      .addFields(
        {
          name: 'Minimum gamerscore',
          value: `\`${settings.minScore}\``,
          inline: true,
        },
        {
          name: 'Punishment',
          value: punishmentSummary(settings),
          inline: true,
        }
      ),
    guild,
    { context: 'Gamerscore detection' }
  );

  await channel.send({ embeds: [embed] });
  return { ok: true };
}

function botModerator(discordGuild) {
  const user = discordGuild.client?.user;
  const id = user?.id || '0';
  const tag = user?.tag || 'Megapithacus';
  return {
    id,
    tag,
    toString() {
      return `<@${id}>`;
    },
  };
}

async function postDetectionLog(discordGuild, guildId, fields) {
  const guild = getGuild(guildId);
  const channelId = guild.featureSetup?.gamerscoreDetection?.channelId;
  if (!channelId) return { ok: false, error: 'No log channel' };

  const channel = await discordGuild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return { ok: false, error: 'Log channel missing' };

  const color =
    fields.outcome === 'punish'
      ? 0xe74c3c
      : fields.outcome === 'pass'
        ? 0x2ecc71
        : 0xf1c40f;

  const embed = brandEmbed(
    new EmbedBuilder()
      .setTitle(
        fields.outcome === 'punish'
          ? 'Gamerscore below threshold'
          : fields.outcome === 'pass'
            ? 'Gamerscore check passed'
            : 'Gamerscore could not verify'
      )
      .setColor(color)
      .addFields(
        {
          name: 'Player',
          value: fields.playerName || 'Unknown',
          inline: true,
        },
        {
          name: 'Gamerscore',
          value:
            fields.gamerscore != null
              ? String(fields.gamerscore)
              : '_unverifiable_',
          inline: true,
        },
        {
          name: 'Minimum',
          value: String(fields.minScore ?? 0),
          inline: true,
        },
        {
          name: 'Action',
          value: fields.action || 'None',
          inline: true,
        },
        {
          name: 'Map / server',
          value: fields.mapServer || '—',
          inline: true,
        }
      ),
    guild,
    { context: 'Gamerscore detection' }
  );

  if (fields.note) {
    embed.setDescription(fields.note.slice(0, 2000));
  }

  await channel.send({ embeds: [embed] });
  return { ok: true };
}

/**
 * Run after a player join is detected. Fail-open when score cannot be fetched.
 */
async function handleGamerscoreJoin(discordGuild, guildId, {
  profile,
  mapName,
  serverName,
  serviceId,
}) {
  const guild = getGuild(guildId);
  if (
    !isFeatureEnabled(guild, 'gamerscoreDetection') ||
    !isFeatureConfigured(guild, 'gamerscoreDetection')
  ) {
    return { skipped: true, reason: 'disabled' };
  }

  const settings = settingsFor(guild);
  const gamertag =
    profile?.gamertag ||
    profile?.characterName ||
    profile?.name ||
    null;
  const playerName =
    profile?.gamertag ||
    profile?.characterName ||
    profile?.specimenImplant ||
    'Unknown';
  const mapServer = [mapName || profile?.map, serverName]
    .filter(Boolean)
    .join(' · ') || String(serviceId || '—');

  if (!gamertag) {
    await postDetectionLog(discordGuild, guildId, {
      outcome: 'unverified',
      playerName,
      gamerscore: null,
      minScore: settings.minScore,
      action: 'Allowed (no gamertag)',
      mapServer,
      note: 'Could not verify — player had no Xbox gamertag on the Nitrado payload.',
    }).catch((err) =>
      console.warn('Gamerscore log failed:', err.message)
    );
    return { skipped: true, reason: 'no-gamertag' };
  }

  if (!hasApiKey()) {
    await postDetectionLog(discordGuild, guildId, {
      outcome: 'unverified',
      playerName,
      gamerscore: null,
      minScore: settings.minScore,
      action: 'Allowed (could not verify)',
      mapServer,
      note:
        'Could not verify gamerscore right now. Fail-open: player was not punished.',
    }).catch((err) =>
      console.warn('Gamerscore log failed:', err.message)
    );
    return { skipped: true, reason: 'no-api-key' };
  }

  const lookup = await getGamerscore(gamertag);
  if (!lookup.ok) {
    await postDetectionLog(discordGuild, guildId, {
      outcome: 'unverified',
      playerName,
      gamerscore: null,
      minScore: settings.minScore,
      action: 'Allowed (could not verify)',
      mapServer,
      note:
        'Could not verify gamerscore right now. Fail-open: player was not punished.',
    }).catch((err) =>
      console.warn('Gamerscore log failed:', err.message)
    );
    return { skipped: true, reason: 'lookup-failed', error: lookup.error };
  }

  const verdict = evaluateThreshold(lookup.gamerscore, settings.minScore);
  if (verdict.pass) {
    if (settings.logPasses) {
      await postDetectionLog(discordGuild, guildId, {
        outcome: 'pass',
        playerName,
        gamerscore: lookup.gamerscore,
        minScore: settings.minScore,
        action: 'Allowed',
        mapServer,
      }).catch((err) =>
        console.warn('Gamerscore log failed:', err.message)
      );
    }
    return { ok: true, pass: true, gamerscore: lookup.gamerscore };
  }

  const punishment = settings.punishment;
  let actionLabel =
    punishment === 'ban'
      ? settings.durationMinutes > 0
        ? `Temp ban (${settings.durationMinutes}m)`
        : 'Permanent ban'
      : 'Kick';

  let moderateResult = null;
  if (profile?.id) {
    const banArgs =
      punishment === 'ban'
        ? settings.durationMinutes > 0
          ? {
              durationValue: 'custom',
              durationLabel: `${settings.durationMinutes} minute${
                settings.durationMinutes === 1 ? '' : 's'
              }`,
              durationMs: settings.durationMinutes * 60 * 1000,
            }
          : {
              durationValue: 'perm',
              durationLabel: 'Permanent',
              durationMs: null,
            }
        : {};

    moderateResult = await moderatePlayer(discordGuild, {
      profileId: profile.id,
      action: punishment === 'ban' ? 'ban' : 'kick',
      moderator: botModerator(discordGuild),
      reason: `Gamerscore ${lookup.gamerscore} below minimum ${settings.minScore}`,
      ...banArgs,
    });

    if (!moderateResult.ok) {
      actionLabel = `${actionLabel} failed: ${moderateResult.error || 'unknown'}`;
    } else if (moderateResult.nitrado?.summary) {
      actionLabel = `${actionLabel} — ${moderateResult.nitrado.summary}`;
    }
  } else {
    actionLabel = `${actionLabel} skipped (no profile id)`;
  }

  await postDetectionLog(discordGuild, guildId, {
    outcome: 'punish',
    playerName,
    gamerscore: lookup.gamerscore,
    minScore: settings.minScore,
    action: actionLabel,
    mapServer,
  }).catch((err) => console.warn('Gamerscore log failed:', err.message));

  return {
    ok: Boolean(moderateResult?.ok),
    pass: false,
    gamerscore: lookup.gamerscore,
    punishment,
    moderateResult,
  };
}

module.exports = {
  handleGamerscoreJoin,
  settingsFor,
  punishmentSummary,
  punishmentTimingText,
  formatBanDuration,
  postDetectionLog,
  postSetupReadyEmbed,
};

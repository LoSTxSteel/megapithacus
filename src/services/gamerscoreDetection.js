const { EmbedBuilder } = require('discord.js');
const { getGuild, updateGuild, normalizeGamertag } = require('./storage');
const {
  isFeatureEnabled,
  isFeatureConfigured,
} = require('./featureSetup');
const { getGamerscore, evaluateThreshold, hasApiKey } = require('./gamerscore');
const { upsertPlayer } = require('./playerDb');
const { moderatePlayer } = require('./playerModeration');
const { logKick } = require('./banLog');
const {
  kickPlayerOnCluster,
  banPlayerOnCluster,
} = require('./nitradoModeration');
const { brandEmbed } = require('../utils/embeds');

function settingsFor(guild) {
  const s = guild.gamerscoreDetection || {};
  return {
    minScore: Math.max(0, Number(s.minScore) || 0),
    punishment: s.punishment === 'ban' ? 'ban' : 'kick',
    // Bans are always permanent (duration UI removed)
    durationMinutes: 0,
    // Kept for storage compat; no UI toggle — default off
    logPasses: Boolean(s.logPasses),
  };
}

/**
 * Stable keys for the once-ever checked set.
 * Prefer normalized Xbox gamertag, then nitrado / platform ids.
 */
function gamerscoreCheckKeys(profile) {
  const keys = [];
  const gt = normalizeGamertag(profile?.gamertag || '').toLowerCase();
  if (gt) keys.push(`gt:${gt}`);
  const nid = profile?.nitradoPlayerId
    ? String(profile.nitradoPlayerId).trim()
    : '';
  if (nid) keys.push(`nid:${nid}`);
  const pid = profile?.platformId ? String(profile.platformId).trim() : '';
  if (pid) keys.push(`pid:${pid}`);
  return keys;
}

function checkedPlayersMap(guildId) {
  const guild = getGuild(guildId);
  const map = guild.gamerscoreDetection?.checkedPlayers;
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
}

function isGamerscoreChecked(guildId, profile) {
  const map = checkedPlayersMap(guildId);
  const keys = gamerscoreCheckKeys(profile);
  if (!keys.length) return false;
  return keys.some((k) => Boolean(map[k]));
}

/** Persist that a check attempt completed — never re-check this player. */
function markGamerscoreChecked(guildId, profile) {
  const keys = gamerscoreCheckKeys(profile);
  if (!keys.length) return false;
  const prev = checkedPlayersMap(guildId);
  const next = { ...prev };
  const now = new Date().toISOString();
  let changed = false;
  for (const k of keys) {
    if (!next[k]) {
      next[k] = now;
      changed = true;
    }
  }
  if (!changed) return false;
  updateGuild(guildId, {
    gamerscoreDetection: { checkedPlayers: next },
  });
  return true;
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
  if (settings.punishment === 'ban') return 'permanent ban';
  return 'kick';
}

/** Member-facing explanation of when / how long punishment applies. */
function punishmentTimingText(settings) {
  if (settings.punishment === 'ban') {
    return 'Players below the minimum will be **permanently banned** when they join a map.';
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
 * Join-time profile shape for Nitrado Player Management kick/ban.
 * Prefer live poll fields (nitradoPlayerId / serviceId) over a later DB re-read.
 */
function kickTargetFromJoin(profile, { gamertag, mapName, serviceId }) {
  return {
    id: profile?.id || null,
    gamertag: gamertag || profile?.gamertag || null,
    characterName: profile?.characterName || null,
    specimenImplant: profile?.specimenImplant || null,
    nitradoPlayerId: profile?.nitradoPlayerId
      ? String(profile.nitradoPlayerId).trim()
      : null,
    platformId: profile?.platformId ? String(profile.platformId).trim() : null,
    map: mapName || profile?.map || null,
    serviceId: serviceId
      ? String(serviceId)
      : profile?.serviceId
        ? String(profile.serviceId)
        : null,
    online: true,
  };
}

/**
 * Run after a player join is detected. Fail-open when score cannot be fetched.
 * When score is a finite number below min, punish (kick/ban) via Nitrado.
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

  // Once-ever: skip OpenXBL + punish + channel spam if already checked.
  if (isGamerscoreChecked(guildId, profile)) {
    return { skipped: true, reason: 'already-checked' };
  }

  const settings = settingsFor(guild);
  // OpenXBL must use the Xbox gamertag — never the ARK character / IGN.
  const gamertag = profile?.gamertag
    ? String(profile.gamertag).trim()
    : null;
  const playerName =
    gamertag ||
    profile?.characterName ||
    profile?.specimenImplant ||
    'Unknown';
  const mapServer = [mapName || profile?.map, serverName]
    .filter(Boolean)
    .join(' · ') || String(serviceId || '—');
  const kickTarget = kickTargetFromJoin(profile, {
    gamertag,
    mapName,
    serviceId,
  });

  console.log(
    `[gamerscore] check start guild=${guildId} gt=${gamertag || '(none)'} ` +
      `min=${settings.minScore} punishment=${settings.punishment} ` +
      `nitradoPlayerId=${kickTarget.nitradoPlayerId || '(none)'} ` +
      `serviceId=${kickTarget.serviceId || '(none)'}`
  );

  if (!gamertag) {
    console.warn(`[gamerscore] skip — no Xbox gamertag on Nitrado payload`);
    // Completed attempt (unverifiable) — do not retry forever on rejoin.
    markGamerscoreChecked(guildId, profile);
    await postDetectionLog(discordGuild, guildId, {
      outcome: 'unverified',
      playerName,
      gamerscore: null,
      minScore: settings.minScore,
      action: 'Allowed (no gamertag)',
      mapServer,
      note: 'Could not verify — player had no Xbox gamertag on the Nitrado payload.',
    }).catch((err) =>
      console.warn('[gamerscore] log failed:', err.message)
    );
    return { skipped: true, reason: 'no-gamertag' };
  }

  if (!hasApiKey()) {
    console.warn(
      `[gamerscore] skip — OPENXBL_API_KEY missing (fail-open) gt=${gamertag}`
    );
    markGamerscoreChecked(guildId, { ...profile, gamertag });
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
      console.warn('[gamerscore] log failed:', err.message)
    );
    return { skipped: true, reason: 'no-api-key' };
  }

  const lookup = await getGamerscore(gamertag);
  console.log(
    `[gamerscore] score result gt=${gamertag} ok=${lookup.ok} ` +
      `score=${lookup.gamerscore ?? 'null'} cached=${Boolean(lookup.cached)} ` +
      `err=${lookup.error || ''}`
  );

  if (!lookup.ok || lookup.gamerscore == null || !Number.isFinite(Number(lookup.gamerscore))) {
    // Fail-open verify failure still counts as a completed check attempt.
    markGamerscoreChecked(guildId, { ...profile, gamertag });
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
      console.warn('[gamerscore] log failed:', err.message)
    );
    return {
      skipped: true,
      reason: 'lookup-failed',
      error: lookup.error || 'null-score',
    };
  }

  // Score fetched — mark before punish so rejoins never re-hit OpenXBL.
  markGamerscoreChecked(guildId, { ...profile, gamertag });

  const score = Number(lookup.gamerscore);
  const verdict = evaluateThreshold(score, settings.minScore);
  if (verdict.pass) {
    console.log(
      `[gamerscore] pass gt=${gamertag} score=${score} min=${settings.minScore}`
    );
    if (settings.logPasses) {
      await postDetectionLog(discordGuild, guildId, {
        outcome: 'pass',
        playerName,
        gamerscore: score,
        minScore: settings.minScore,
        action: 'Allowed',
        mapServer,
      }).catch((err) =>
        console.warn('[gamerscore] log failed:', err.message)
      );
    }
    return { ok: true, pass: true, gamerscore: score };
  }

  console.log(
    `[gamerscore] below min gt=${gamertag} score=${score} min=${settings.minScore} ` +
      `→ ${settings.punishment}`
  );

  // Persist live Nitrado ids before any DB-based moderation helpers run.
  if (profile?.id || gamertag) {
    upsertPlayer(guildId, {
      gamertag,
      characterName: profile?.characterName,
      specimenImplant: profile?.specimenImplant,
      nitradoPlayerId: kickTarget.nitradoPlayerId,
      platformId: kickTarget.platformId,
      map: kickTarget.map,
      serviceId: kickTarget.serviceId,
      serverName: serverName || null,
      online: true,
    });
  }

  const punishment = settings.punishment;
  let actionLabel =
    punishment === 'ban'
      ? settings.durationMinutes > 0
        ? `Temp ban (${settings.durationMinutes}m)`
        : 'Permanent ban'
      : 'Kick';
  let punishOk = false;
  let nitrado = null;
  let moderateResult = null;
  const reason = `Gamerscore ${score} below minimum ${settings.minScore}`;

  try {
    if (punishment === 'kick') {
      // Player Management only on the join serviceId — never console KickPlayer
      // (POST .../gameservers/command reliably 500s on ASE arkxb).
      if (!kickTarget.nitradoPlayerId) {
        punishOk = false;
        actionLabel =
          'Kick failed: missing nitradoPlayerId on join payload ' +
          '(need online-list id from GET .../games/players)';
        nitrado = {
          ok: false,
          anyOk: false,
          error: actionLabel,
        };
        console.warn(
          `[gamerscore] kick aborted gt=${gamertag} — no nitradoPlayerId ` +
            `serviceId=${kickTarget.serviceId || '(none)'}`
        );
      } else {
        nitrado = await kickPlayerOnCluster(guild, kickTarget, {
          playerManagementOnly: true,
          allowClusterFallback: false,
          allowConsoleFallback: false,
          reason,
        });
        punishOk = Boolean(nitrado?.ok && nitrado.anyOk);
        console.log(
          `[gamerscore] kick result gt=${gamertag} ok=${Boolean(nitrado?.ok)} ` +
            `anyOk=${Boolean(nitrado?.anyOk)} ` +
            `nitradoPlayerId=${kickTarget.nitradoPlayerId || '(none)'} ` +
            `serviceId=${kickTarget.serviceId || '(none)'} ` +
            `summary=${nitrado?.summary || nitrado?.error || ''}`
        );

        if (!punishOk) {
          const detail =
            nitrado?.error ||
            nitrado?.results?.find((r) => r.error)?.error ||
            nitrado?.summary ||
            'unknown';
          actionLabel = `Kick failed (Player Management): ${detail}`;
        } else if (nitrado.summary) {
          actionLabel = `Kick — ${nitrado.summary}`;
        }
      }

      if (punishOk) {
        const stamp = new Date().toISOString();
        const moderator = botModerator(discordGuild);
        const noteLine = `[${stamp}] KICK by ${moderator.tag}: ${reason}`;
        upsertPlayer(guildId, {
          gamertag,
          characterName: kickTarget.characterName,
          specimenImplant: kickTarget.specimenImplant,
          nitradoPlayerId: kickTarget.nitradoPlayerId,
          platformId: kickTarget.platformId,
          map: kickTarget.map,
          serviceId: kickTarget.serviceId,
          online: false,
          notes: [profile?.notes, noteLine].filter(Boolean).join('\n').slice(0, 1000),
        });
        await logKick(discordGuild, {
          targetGamertag: playerName,
          gamertag,
          characterName: kickTarget.characterName,
          specimenImplant: kickTarget.specimenImplant,
          reason,
          map: kickTarget.map,
          moderatorId: moderator.id,
          moderatorTag: `${moderator}`,
        }).catch((err) =>
          console.warn(`[gamerscore] kick log forum failed: ${err.message}`)
        );
      }
    } else {
      // Ban: prefer full moderatePlayer (banlist + ban store + logs). Fall back to
      // direct Nitrado ban if profile id is missing.
      if (profile?.id) {
        const banArgs =
          settings.durationMinutes > 0
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
              };

        moderateResult = await moderatePlayer(discordGuild, {
          profileId: profile.id,
          action: 'ban',
          moderator: botModerator(discordGuild),
          reason,
          ...banArgs,
        });
        punishOk = Boolean(moderateResult?.ok);
        nitrado = moderateResult?.nitrado || null;
        if (!punishOk) {
          actionLabel = `${actionLabel} failed: ${moderateResult?.error || 'unknown'}`;
        } else if (nitrado?.summary) {
          actionLabel = `${actionLabel} — ${nitrado.summary}`;
        }
      } else {
        nitrado = await banPlayerOnCluster(guild, kickTarget);
        punishOk = Boolean(nitrado?.ok && nitrado.anyOk);
        if (!punishOk) {
          actionLabel = `Ban failed: ${nitrado?.error || nitrado?.summary || 'unknown'}`;
        } else if (nitrado.summary) {
          actionLabel = `Ban — ${nitrado.summary}`;
        }
      }
      console.log(
        `[gamerscore] ban result gt=${gamertag} ok=${punishOk} ` +
          `summary=${nitrado?.summary || moderateResult?.error || ''}`
      );
    }
  } catch (error) {
    punishOk = false;
    actionLabel = `${actionLabel} failed: ${error.message || 'unknown'}`;
    console.warn(
      `[gamerscore] punish threw gt=${gamertag}: ${error.message}`
    );
  }

  await postDetectionLog(discordGuild, guildId, {
    outcome: 'punish',
    playerName,
    gamerscore: score,
    minScore: settings.minScore,
    action: actionLabel,
    mapServer,
    note: punishOk
      ? null
      : [
          'Punishment did not complete.',
          actionLabel,
          kickTarget.nitradoPlayerId
            ? `nitradoPlayerId=\`${kickTarget.nitradoPlayerId}\``
            : 'nitradoPlayerId=_missing_',
          kickTarget.serviceId
            ? `serviceId=\`${kickTarget.serviceId}\``
            : 'serviceId=_missing_',
        ]
          .filter(Boolean)
          .join('\n'),
  }).catch((err) => console.warn('[gamerscore] log failed:', err.message));

  return {
    ok: punishOk,
    pass: false,
    gamerscore: score,
    punishment,
    nitrado,
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
  isGamerscoreChecked,
  markGamerscoreChecked,
  gamerscoreCheckKeys,
};

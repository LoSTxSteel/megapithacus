const { getGuild } = require('./storage');
const { getPlayerById, upsertPlayer } = require('./playerDb');
const { logBan, logUnban, logKick } = require('./banLog');
const {
  createBan,
  durationMeta,
  findActiveBanForPlayer,
  deactivateBan,
} = require('./banStore');
const {
  banPlayerOnCluster,
  unbanPlayerOnCluster,
  kickPlayerOnCluster,
} = require('./nitradoModeration');
const { onBanCreated } = require('./banReminders');

function appendNitradoNote(message, nitrado) {
  if (!nitrado?.summary) return message;
  return `${message}\n${nitrado.summary}`;
}

function isTestProfile(profile) {
  return (
    profile?.notes === 'FAKE_TEST_PROFILE' ||
    String(profile?.serviceId || '').startsWith('fake')
  );
}

function localOnlyNitrado(actionLabel) {
  return {
    ok: true,
    identifier: null,
    okCount: 0,
    failCount: 0,
    skippedCount: 0,
    realCount: 0,
    results: [],
    summary: `Test profile — Nitrado ${actionLabel} skipped (no live servers required).`,
    anyOk: false,
    allFailed: false,
    noRealServers: true,
    testProfile: true,
  };
}

async function moderatePlayer(discordGuild, {
  profileId,
  action,
  moderator,
  reason,
  durationValue,
  durationLabel,
  durationMs,
}) {
  const profile = getPlayerById(discordGuild.id, profileId);
  if (!profile) {
    return { ok: false, error: 'Player profile not found.' };
  }

  const guild = getGuild(discordGuild.id);
  const serverNames = (guild.servers || []).map((s) => s.name);
  const target =
    profile.gamertag || profile.characterName || profile.specimenImplant || 'Unknown';
  const testProfile = isTestProfile(profile);

  const stamp = new Date().toISOString();

  if (!testProfile && !(guild.servers || []).length) {
    return {
      ok: false,
      error:
        'No Nitrado servers synced. Use **/management → Server Setup** to add tokens and sync services first.',
    };
  }

  if (action === 'kick') {
    const nitrado = testProfile
      ? localOnlyNitrado('kick')
      : await kickPlayerOnCluster(guild, profile);
    if (!nitrado.ok && !nitrado.noRealServers) {
      return { ok: false, error: nitrado.error || 'Nitrado kick failed.' };
    }

    const noteLine = `[${stamp}] KICK by ${moderator.tag}: ${reason}`;
    upsertPlayer(discordGuild.id, {
      gamertag: profile.gamertag,
      characterName: profile.characterName,
      specimenImplant: profile.specimenImplant,
      tribeName: profile.tribeName,
      tribeId: profile.tribeId,
      map: profile.map,
      serviceId: profile.serviceId,
      notes: [profile.notes, noteLine].filter(Boolean).join('\n').slice(0, 1000),
      online: false,
    });

    const kickRecord = {
      targetGamertag: target,
      gamertag: profile.gamertag,
      characterName: profile.characterName,
      specimenImplant: profile.specimenImplant,
      reason,
      map: profile.map,
      moderatorId: moderator.id,
      moderatorTag: `${moderator}`,
    };
    const kickLog = await logKick(discordGuild, kickRecord);

    return {
      ok: true,
      profile,
      target,
      nitrado,
      kickLog,
      message: appendNitradoNote(
        testProfile
          ? `Test kick recorded for **${target}** (Nitrado skipped).`
          : nitrado.noRealServers
            ? `Kick recorded for **${target}** (no live Nitrado services to command).`
            : kickLog.ok
              ? `Kicked **${target}** via Nitrado. Kick log created.`
              : `Kicked **${target}** via Nitrado.`,
        nitrado
      ),
    };
  }

  if (action === 'ban') {
    const startsAt = new Date();
    let label = 'Permanent';
    let endsAt = null;
    let storedDurationValue = durationValue || 'perm';

    if (durationValue === 'custom') {
      if (durationMs == null || !Number.isFinite(durationMs) || durationMs <= 0) {
        return { ok: false, error: 'Custom duration is missing or invalid.' };
      }
      label = durationLabel || 'Custom';
      endsAt = new Date(startsAt.getTime() + durationMs).toISOString();
      storedDurationValue = 'custom';
    } else {
      const meta = durationValue ? durationMeta(durationValue) : null;
      label = durationLabel || meta?.label || 'Permanent';
      endsAt =
        meta?.ms != null ? new Date(startsAt.getTime() + meta.ms).toISOString() : null;
    }

    const nitrado = testProfile
      ? localOnlyNitrado('ban')
      : await banPlayerOnCluster(guild, profile);
    if (!nitrado.ok && !nitrado.noRealServers) {
      return { ok: false, error: nitrado.error || 'Nitrado ban failed.' };
    }

    const noteLine = `[${stamp}] BAN by ${moderator.tag}: ${reason} (${label})`;
    upsertPlayer(discordGuild.id, {
      gamertag: profile.gamertag,
      characterName: profile.characterName,
      specimenImplant: profile.specimenImplant,
      tribeName: profile.tribeName,
      tribeId: profile.tribeId,
      map: profile.map,
      serviceId: profile.serviceId,
      notes: [profile.notes, noteLine].filter(Boolean).join('\n').slice(0, 1000),
      online: false,
    });

    const banRecord = createBan({
      guildId: discordGuild.id,
      profileId: profile.id,
      gamertag: profile.gamertag,
      characterName: profile.characterName,
      specimenImplant: profile.specimenImplant,
      targetGamertag: target,
      reason,
      duration: label,
      durationValue: storedDurationValue,
      customDurationMs: durationValue === 'custom' ? durationMs : null,
      startsAt: startsAt.toISOString(),
      endsAt,
      moderatorId: moderator.id,
      moderatorTag: `${moderator}`,
      serverCount: serverNames.length || 1,
      servers: serverNames.length ? serverNames : [profile.map].filter(Boolean),
      nitrado: {
        identifier: nitrado.identifier,
        okCount: nitrado.okCount,
        failCount: nitrado.failCount,
        summary: nitrado.summary,
      },
    });

    const banLog = await logBan(discordGuild, banRecord);
    const { updateBan, getBanById } = require('./banStore');
    if (banLog.threadId) {
      updateBan(banRecord.id, { banLogThreadId: banLog.threadId });
    }

    // Exact expiry timers (critical for short/custom bans)
    try {
      onBanCreated(getBanById(banRecord.id) || banRecord);
    } catch (error) {
      console.warn('Ban timer schedule failed:', error.message);
    }

    const base = testProfile
      ? `Test ban issued for **${target}** (${label}) — Nitrado skipped.`
      : nitrado.noRealServers
        ? `Ban issued for **${target}** (${label}) — local only (no live Nitrado services).`
        : banLog.ok
          ? `Banned **${target}** in-game (${label}). Ban log created.`
          : `Banned **${target}** in-game (${label}). Enable **Ban Logging** for forum logs — ban is still saved.`;

    return {
      ok: true,
      profile,
      target,
      ban: banRecord,
      banLog,
      nitrado,
      message: appendNitradoNote(base, nitrado),
    };
  }

  if (action === 'unban') {
    const nitrado = testProfile
      ? localOnlyNitrado('unban')
      : await unbanPlayerOnCluster(guild, profile);
    if (!nitrado.ok && !nitrado.noRealServers) {
      return { ok: false, error: nitrado.error || 'Nitrado unban failed.' };
    }

    const activeBan = findActiveBanForPlayer(discordGuild.id, profile);
    const noteLine = `[${stamp}] UNBAN by ${moderator.tag}: ${reason}`;
    upsertPlayer(discordGuild.id, {
      gamertag: profile.gamertag,
      characterName: profile.characterName,
      specimenImplant: profile.specimenImplant,
      tribeName: profile.tribeName,
      tribeId: profile.tribeId,
      map: profile.map,
      serviceId: profile.serviceId,
      notes: [profile.notes, noteLine].filter(Boolean).join('\n').slice(0, 1000),
    });

    const unbanMeta = {
      targetGamertag: target,
      characterName: profile.characterName,
      specimenImplant: profile.specimenImplant,
      reason,
      moderatorId: moderator.id,
      moderatorTag: `${moderator}`,
      unbannedAt: stamp,
      nitrado: {
        identifier: nitrado.identifier,
        okCount: nitrado.okCount,
        failCount: nitrado.failCount,
        summary: nitrado.summary,
      },
    };

    let updatedBan = activeBan;
    if (activeBan) {
      updatedBan = deactivateBan(activeBan.id, {
        unbannedAt: stamp,
        unbannedById: moderator.id,
        unbannedByTag: `${moderator}`,
        unbanReason: reason,
        nitradoUnban: unbanMeta.nitrado,
      });
    }

    const unbanLog = await logUnban(discordGuild, updatedBan || activeBan, unbanMeta);
    if (updatedBan && unbanLog.threadId) {
      const { updateBan } = require('./banStore');
      updateBan(updatedBan.id, { unbanLogThreadId: unbanLog.threadId });
    }

    const base = testProfile
      ? `Test unban recorded for **${target}** — Nitrado skipped.`
      : nitrado.noRealServers
        ? `Unban recorded for **${target}** — local only (no live Nitrado services).`
        : unbanLog.ok
          ? `Unbanned **${target}** in-game. Unban log created.`
          : `Unbanned **${target}** in-game. Enable **Ban Logging** for forum logs — unban is still saved.`;

    return {
      ok: true,
      profile,
      target,
      ban: updatedBan || activeBan,
      unbanLog,
      nitrado,
      message: appendNitradoNote(base, nitrado),
    };
  }

  return { ok: false, error: 'Unknown action.' };
}

module.exports = { moderatePlayer };

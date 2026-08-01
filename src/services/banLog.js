const { EmbedBuilder } = require('discord.js');
const { getGuild } = require('./storage');
const { isFeatureEnabled, isFeatureConfigured } = require('./featureSetup');
const { formatPingContent } = require('./pingRoles');
const { brand } = require('../config');
const { footerForGuild } = require('../utils/embeds');

function buildBanLogEmbed(ban, guildConfig) {
  const target = ban.targetGamertag || ban.gamertag || 'Unknown';
  const serverList =
    Array.isArray(ban.servers) && ban.servers.length
      ? ban.servers.map((s) => `• ${s}`).join('\n')
      : '_Not specified_';

  const endsValue = ban.endsAt
    ? `<t:${Math.floor(new Date(ban.endsAt).getTime() / 1000)}:F> (<t:${Math.floor(
        new Date(ban.endsAt).getTime() / 1000
      )}:R>)`
    : 'Never (permanent)';

  return new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('Ban log')
    .addFields(
      { name: 'Who got banned', value: `\`${target}\``, inline: true },
      { name: 'In-game name', value: ban.characterName || '—', inline: true },
      {
        name: 'Specimen Implant',
        value: ban.specimenImplant ? `\`${ban.specimenImplant}\`` : '—',
        inline: true,
      },
      { name: 'Banned by', value: String(ban.moderatorTag || 'Unknown'), inline: true },
      { name: 'Duration', value: String(ban.duration || 'Unknown'), inline: true },
      {
        name: 'Servers affected',
        value: `${ban.serverCount ?? ban.servers?.length ?? 0} server(s)`,
        inline: true,
      },
      { name: 'Ends', value: endsValue },
      { name: 'Reason', value: ban.reason || 'No reason provided' },
      { name: 'Server list', value: serverList }
    )
    .setFooter({ text: `${footerForGuild(guildConfig)} · Ban Logging` })
    .setTimestamp(ban.startsAt ? new Date(ban.startsAt) : new Date());
}

function buildKickLogEmbed(kick, guildConfig) {
  const target = kick.targetGamertag || kick.gamertag || 'Unknown';
  return new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('Kick log')
    .addFields(
      { name: 'Who got kicked', value: `\`${target}\``, inline: true },
      { name: 'In-game name', value: kick.characterName || '—', inline: true },
      {
        name: 'Specimen Implant',
        value: kick.specimenImplant ? `\`${kick.specimenImplant}\`` : '—',
        inline: true,
      },
      { name: 'Kicked by', value: String(kick.moderatorTag || 'Unknown'), inline: true },
      { name: 'Map', value: kick.map || '—', inline: true },
      { name: 'Reason', value: kick.reason || 'No reason provided' }
    )
    .setFooter({ text: `${footerForGuild(guildConfig)} · Ban Logging` })
    .setTimestamp();
}

async function createModLogThread(discordGuild, guildConfig, { name, content, embed }) {
  if (!isFeatureEnabled(guildConfig, 'banLogging')) {
    return { ok: false, reason: 'disabled', embed };
  }
  if (!isFeatureConfigured(guildConfig, 'banLogging')) {
    return { ok: false, reason: 'not_configured', embed };
  }

  const forumId = guildConfig.featureSetup.banLogging.forumId;
  const forum = await discordGuild.channels.fetch(forumId).catch(() => null);
  if (!forum) {
    return { ok: false, reason: 'missing_forum', embed };
  }

  const message = { embeds: [embed] };
  if (content) message.content = content;

  const thread = await forum.threads.create({
    name: String(name).slice(0, 100),
    message,
  });

  return { ok: true, threadId: thread.id, embed };
}

/**
 * Create a ban log forum thread when Ban Logging is set up.
 */
async function logBan(discordGuild, ban) {
  const guildConfig = getGuild(discordGuild.id);
  const embed = buildBanLogEmbed(ban, guildConfig);
  const target = ban.targetGamertag || ban.gamertag || 'Unknown';
  const content = formatPingContent(guildConfig, 'ban');

  return createModLogThread(discordGuild, guildConfig, {
    name: `Ban: ${String(target).slice(0, 80)}`,
    content,
    embed,
  });
}

function buildUnbanLogEmbed(ban, unban, guildConfig) {
  const target =
    unban?.targetGamertag ||
    ban?.targetGamertag ||
    ban?.gamertag ||
    'Unknown';

  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('Unban log')
    .addFields(
      { name: 'Who got unbanned', value: `\`${target}\``, inline: true },
      { name: 'In-game name', value: ban?.characterName || unban?.characterName || '—', inline: true },
      {
        name: 'Specimen Implant',
        value:
          ban?.specimenImplant || unban?.specimenImplant
            ? `\`${ban?.specimenImplant || unban?.specimenImplant}\``
            : '—',
        inline: true,
      },
      { name: 'Unbanned by', value: String(unban?.moderatorTag || 'Unknown'), inline: true },
      {
        name: 'Original ban duration',
        value: ban?.duration || '—',
        inline: true,
      },
      {
        name: 'Original ban reason',
        value: ban?.reason || '—',
        inline: true,
      },
      { name: 'Unban reason', value: unban?.reason || 'No reason provided' }
    )
    .setFooter({ text: `${footerForGuild(guildConfig)} · Ban Logging` })
    .setTimestamp();
}

/**
 * Create an unban log forum thread when Ban Logging is set up.
 */
async function logUnban(discordGuild, ban, unban) {
  const guildConfig = getGuild(discordGuild.id);
  const embed = buildUnbanLogEmbed(ban, unban, guildConfig);
  const target =
    unban?.targetGamertag || ban?.targetGamertag || ban?.gamertag || 'Unknown';
  const content = formatPingContent(guildConfig, 'unban');

  return createModLogThread(discordGuild, guildConfig, {
    name: `Unban: ${String(target).slice(0, 80)}`,
    content,
    embed,
  });
}

/**
 * Create a kick log forum thread when Ban Logging is set up.
 */
async function logKick(discordGuild, kick) {
  const guildConfig = getGuild(discordGuild.id);
  const embed = buildKickLogEmbed(kick, guildConfig);
  const target = kick.targetGamertag || kick.gamertag || 'Unknown';
  const content = formatPingContent(guildConfig, 'kick');

  return createModLogThread(discordGuild, guildConfig, {
    name: `Kick: ${String(target).slice(0, 80)}`,
    content,
    embed,
  });
}

async function postBanReminder(discordGuild, ban, kind) {
  const guildConfig = getGuild(discordGuild.id);
  if (!isFeatureConfigured(guildConfig, 'banLogging')) {
    return { ok: false, reason: 'not_configured' };
  }

  const forumId = guildConfig.featureSetup.banLogging.forumId;
  const forum = await discordGuild.channels.fetch(forumId).catch(() => null);
  if (!forum) return { ok: false, reason: 'missing_forum' };

  const target = ban.targetGamertag || ban.gamertag || 'Unknown';
  const endsUnix = ban.endsAt
    ? Math.floor(new Date(ban.endsAt).getTime() / 1000)
    : null;

  let title = 'Ban reminder';
  let description = '';
  if (kind === '24h') {
    title = '⏰ Ban ending in under 24 hours';
    description = `Admin reminder: **${target}**'s ban ends <t:${endsUnix}:R>.`;
  } else if (kind === '1h') {
    title = '⏰ Ban ending in under 1 hour';
    description = `Admin reminder: **${target}**'s ban ends <t:${endsUnix}:R>.`;
  } else if (kind === 'expired') {
    title = '✅ Ban expired';
    description = ban.autoUnbannedAt
      ? `**${target}**'s ban has ended. Megapithacus processed the expiry (Nitrado unban attempted if servers were linked).`
      : `**${target}**'s ban has ended. Review / confirm they are unbanned in-game.`;
  }

  const embed = new EmbedBuilder()
    .setColor(kind === 'expired' ? 0x2ecc71 : 0xf39c12)
    .setTitle(title)
    .setDescription(description)
    .addFields(
      { name: 'Player', value: `\`${target}\``, inline: true },
      { name: 'Reason', value: ban.reason || '—', inline: true },
      { name: 'Original duration', value: ban.duration || '—', inline: true },
      {
        name: 'Banned by',
        value: ban.moderatorTag || '—',
        inline: true,
      },
      {
        name: 'Ends',
        value: endsUnix ? `<t:${endsUnix}:F>` : '—',
        inline: true,
      }
    )
    .setFooter({ text: `${footerForGuild(guildConfig)} · Ban reminders` })
    .setTimestamp();

  const content =
    formatPingContent(
      guildConfig,
      'reminder',
      kind === 'expired' ? '✅ **Ban expired — admin notice**' : '⚠️ **Admin ban reminder**'
    ) ||
    (kind === 'expired'
      ? '✅ **Ban expired — admin notice**'
      : '⚠️ **Admin ban reminder**');

  // Prefer posting into the original ban log thread so staff see it immediately
  if (ban.banLogThreadId) {
    const existing = await discordGuild.channels
      .fetch(ban.banLogThreadId)
      .catch(() => null);
    if (existing?.isThread?.() || existing?.send) {
      try {
        await existing.send({ content, embeds: [embed] });
        return { ok: true, threadId: existing.id, reusedThread: true };
      } catch (error) {
        console.warn('Ban reminder reply failed, creating new thread:', error.message);
      }
    }
  }

  const thread = await forum.threads.create({
    name: `${kind === 'expired' ? 'Expired' : 'Reminder'}: ${String(target).slice(0, 70)}`,
    message: {
      content,
      embeds: [embed],
    },
  });

  return { ok: true, threadId: thread.id };
}

module.exports = {
  logBan,
  logUnban,
  logKick,
  buildBanLogEmbed,
  buildUnbanLogEmbed,
  buildKickLogEmbed,
  postBanReminder,
};

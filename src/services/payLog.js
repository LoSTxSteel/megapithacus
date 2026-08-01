const { EmbedBuilder } = require('discord.js');
const { getGuild, updateGuild } = require('./storage');
const {
  isFeatureEnabled,
  isFeatureConfigured,
  setupFeature,
} = require('./featureSetup');
const { money, getAdminPay, formatPaymentDetails } = require('./adminPay');
const { brandEmbed } = require('../utils/embeds');

/**
 * Ensure the Admin Pay forum exists and is enabled (approvals + logs).
 */
async function ensurePayApprovalForum(discordGuild) {
  const setup = await setupFeature(discordGuild, 'payLogging');
  const guildConfig = getGuild(discordGuild.id);
  if (!guildConfig.features?.payLogging) {
    updateGuild(discordGuild.id, {
      features: {
        ...(guildConfig.features || {}),
        payLogging: true,
      },
    });
  }
  return setup.forum;
}

const LOG_META = {
  work: { title: 'Event approved', color: 0x3b82f6 },
  payout: { title: 'Payout recorded', color: 0x22c55e },
  credit: { title: 'Bonus added', color: 0xa855f7 },
  deduction: { title: 'Balance adjusted', color: 0xf97316 },
  roster: { title: 'Roster update', color: 0x64748b },
};

function memberLabel(entry) {
  return entry.userId ? `<@${entry.userId}>` : '—';
}

function buildPayLogEmbed(entry, { guildConfig, adminPay }) {
  const pay = adminPay || getAdminPay(guildConfig?.id || entry.guildId);
  const meta = LOG_META[entry.type] || {
    title: 'Admin Pay',
    color: 0x3b82f6,
  };

  const embed = brandEmbed(new EmbedBuilder().setTitle(meta.title), guildConfig, {
    color: meta.color,
    context: 'Admin Pay',
    timestamp: entry.at ? new Date(entry.at) : new Date(),
  });

  if (entry.type === 'work') {
    embed.setDescription(
      [
        `${memberLabel(entry)} · **${entry.activityLabel || entry.activity || 'Event'}**`,
        `**${money(pay, entry.amount)}** credited`,
      ].join('\n')
    );
    const fields = [];
    if (entry.hostedAt) {
      fields.push({ name: 'Hosted', value: String(entry.hostedAt), inline: true });
    }
    if (entry.attendance != null) {
      fields.push({
        name: 'Attendance',
        value: String(entry.attendance),
        inline: true,
      });
    }
    if (entry.balanceAfter != null) {
      fields.push({
        name: 'Balance',
        value: money(pay, entry.balanceAfter),
        inline: true,
      });
    }
    if (entry.byTag) {
      fields.push({ name: 'Approved by', value: entry.byTag, inline: true });
    }
    if (fields.length) embed.addFields(fields);
  } else if (entry.type === 'payout') {
    embed.setDescription(
      `${memberLabel(entry)} paid **${money(pay, entry.amount)}**`
    );
    const fields = [
      {
        name: 'Remaining',
        value:
          entry.balanceAfter != null ? money(pay, entry.balanceAfter) : '—',
        inline: true,
      },
    ];
    if (entry.paymentMethodLabel || entry.paymentMethod) {
      fields.push({
        name: 'Method',
        value: entry.paymentMethodLabel || entry.paymentMethod,
        inline: true,
      });
    }
    if (entry.byTag) {
      fields.push({ name: 'By', value: entry.byTag, inline: true });
    }
    embed.addFields(fields);
    if (entry.paymentDetails) {
      embed.addFields({
        name: 'Details',
        value: formatPaymentDetails(entry).join('\n').slice(0, 1024),
      });
    }
  } else if (entry.type === 'credit' || entry.type === 'deduction') {
    embed.setDescription(
      `${memberLabel(entry)} · **${money(pay, entry.amount)}**`
    );
    embed.addFields(
      {
        name: 'Balance',
        value:
          entry.balanceAfter != null ? money(pay, entry.balanceAfter) : '—',
        inline: true,
      },
      { name: 'By', value: entry.byTag || '—', inline: true }
    );
  } else if (entry.type === 'roster') {
    embed.setDescription(
      `${memberLabel(entry)} · ${entry.action || 'updated'}`
    );
    if (entry.byTag) {
      embed.addFields({ name: 'By', value: entry.byTag, inline: true });
    }
  }

  if (entry.note) {
    embed.addFields({ name: 'Note', value: entry.note });
  }

  return embed;
}

function payLogThreadName(entry, discordGuild) {
  let who = 'staff';
  if (entry.userId) {
    const member = discordGuild.members.cache.get(entry.userId);
    who =
      member?.displayName ||
      member?.user?.username ||
      `user-${String(entry.userId).slice(-4)}`;
  }

  const prefixes = {
    work: entry.activityLabel || 'Event',
    payout: 'Payout',
    credit: 'Bonus',
    deduction: 'Adjustment',
    roster: 'Roster',
  };
  const prefix = prefixes[entry.type] || 'Admin Pay';
  return `${prefix} · ${who}`.slice(0, 100);
}

async function logPayEvent(discordGuild, entry) {
  const guildConfig = getGuild(discordGuild.id);
  const adminPay = getAdminPay(discordGuild.id);
  const embed = buildPayLogEmbed(
    { ...entry, guildId: discordGuild.id },
    { guildConfig, adminPay }
  );

  if (!isFeatureEnabled(guildConfig, 'payLogging')) {
    return { ok: false, reason: 'disabled', embed };
  }
  if (!isFeatureConfigured(guildConfig, 'payLogging')) {
    return { ok: false, reason: 'not_configured', embed };
  }

  const forumId = guildConfig.featureSetup.payLogging.forumId;
  const forum = await discordGuild.channels.fetch(forumId).catch(() => null);
  if (!forum) {
    return { ok: false, reason: 'missing_forum', embed };
  }

  const thread = await forum.threads.create({
    name: payLogThreadName(entry, discordGuild),
    message: { embeds: [embed] },
  });

  return { ok: true, threadId: thread.id, embed };
}

module.exports = { logPayEvent, buildPayLogEmbed, ensurePayApprovalForum };

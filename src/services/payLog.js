const { EmbedBuilder } = require('discord.js');
const { getGuild, updateGuild } = require('./storage');
const {
  isFeatureEnabled,
  isFeatureConfigured,
  setupFeature,
} = require('./featureSetup');
const { money, getAdminPay, formatPaymentDetails } = require('./adminPay');
const { footerForGuild } = require('../utils/embeds');

/**
 * Ensure the pay-logging forum exists and is enabled (used for manager approvals).
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

function buildPayLogEmbed(entry, { guildConfig, adminPay }) {
  const pay = adminPay || getAdminPay(guildConfig?.id || entry.guildId);
  const colors = {
    work: 0x3498db,
    credit: 0x9b59b6,
    deduction: 0xe67e22,
    payout: 0x2ecc71,
    roster: 0x95a5a6,
  };

  const embed = new EmbedBuilder()
    .setColor(colors[entry.type] || 0x3498db)
    .setTitle(`Pay log · ${entry.type}`)
    .setFooter({ text: `${footerForGuild(guildConfig)} · Pay Logging` })
    .setTimestamp(entry.at ? new Date(entry.at) : new Date());

  if (entry.type === 'work') {
    embed.addFields(
      { name: 'Admin', value: `<@${entry.userId}>`, inline: true },
      {
        name: 'Event type',
        value: entry.activityLabel || entry.activity || '—',
        inline: true,
      },
      { name: 'Amount', value: money(pay, entry.amount), inline: true }
    );
    if (entry.hostedAt) {
      embed.addFields({ name: 'Date & time hosted', value: String(entry.hostedAt) });
    }
    if (entry.attendance != null) {
      embed.addFields({
        name: 'Attendance',
        value: String(entry.attendance),
        inline: true,
      });
    }
    if (entry.balanceAfter != null) {
      embed.addFields({
        name: 'Balance after',
        value: money(pay, entry.balanceAfter),
        inline: true,
      });
    }
    embed.addFields({
      name: 'By',
      value: entry.byTag || '—',
      inline: true,
    });
  } else if (entry.type === 'payout') {
    embed.addFields(
      { name: 'Admin', value: `<@${entry.userId}>`, inline: true },
      { name: 'Paid', value: money(pay, entry.amount), inline: true },
      {
        name: 'Balance after',
        value: entry.balanceAfter != null ? money(pay, entry.balanceAfter) : '—',
        inline: true,
      },
      { name: 'Recorded by', value: entry.byTag || '—', inline: true }
    );
    if (entry.paymentMethodLabel || entry.paymentMethod) {
      embed.addFields({
        name: 'Payment method',
        value: entry.paymentMethodLabel || entry.paymentMethod,
        inline: true,
      });
      embed.addFields({
        name: 'Payment details',
        value: formatPaymentDetails(entry).join('\n').slice(0, 1024),
      });
    }
  } else if (entry.type === 'credit' || entry.type === 'deduction') {
    embed.addFields(
      { name: 'Admin', value: `<@${entry.userId}>`, inline: true },
      { name: 'Amount', value: money(pay, entry.amount), inline: true },
      {
        name: 'Balance after',
        value: entry.balanceAfter != null ? money(pay, entry.balanceAfter) : '—',
        inline: true,
      },
      { name: 'By', value: entry.byTag || '—', inline: true }
    );
  } else if (entry.type === 'roster') {
    embed.addFields(
      { name: 'Admin', value: `<@${entry.userId}>`, inline: true },
      { name: 'Action', value: entry.action || 'updated', inline: true },
      { name: 'By', value: entry.byTag || '—', inline: true }
    );
  }

  if (entry.note) {
    embed.addFields({ name: 'Note', value: entry.note });
  }

  return embed;
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

  const who = entry.userId ? `user-${entry.userId}` : 'pay';
  const thread = await forum.threads.create({
    name: `${entry.type}: ${who}`.slice(0, 100),
    message: { embeds: [embed] },
  });

  return { ok: true, threadId: thread.id, embed };
}

module.exports = { logPayEvent, buildPayLogEmbed, ensurePayApprovalForum };

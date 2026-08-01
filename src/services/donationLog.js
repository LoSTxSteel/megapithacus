const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { getGuild, updateGuild } = require('./storage');
const { setupFeature } = require('./featureSetup');
const { money, updateDonation } = require('./donations');
const { brandEmbed } = require('../utils/embeds');
const { getAdminPay } = require('./adminPay');

async function ensureDonationLogForum(discordGuild) {
  const setup = await setupFeature(discordGuild, 'donationLogging');
  const guildConfig = getGuild(discordGuild.id);
  if (!guildConfig.features?.donationLogging) {
    updateGuild(discordGuild.id, {
      features: {
        ...(guildConfig.features || {}),
        donationLogging: true,
      },
    });
  }
  // Stats channel lives alongside the logs forum
  try {
    const { ensureDonationStatsChannel } = require('./donationStats');
    await ensureDonationStatsChannel(discordGuild);
  } catch (error) {
    console.warn('Donation stats channel setup:', error.message);
  }
  return setup.forum;
}

function statusLabel(record) {
  if (record.status === 'delivered') return 'Delivered';
  if (record.status === 'received' || record.confirmed) return 'Received · confirmed';
  return 'Pending payment confirmation';
}

function statusColor(record) {
  if (record.status === 'delivered') return 0x22c55e;
  if (record.status === 'received' || record.confirmed) return 0x3b82f6;
  return 0xf59e0b;
}

function buildDonationLogEmbed(record, guildConfig) {
  const pay = getAdminPay(guildConfig.id);
  const symbol = pay.currencySymbol || '£';

  const embed = brandEmbed(
    new EmbedBuilder()
      .setTitle(`Donation · ${statusLabel(record)}`)
      .setDescription(
        [
          `**${money(record.amount, symbol)}** via **${record.methodLabel}**`,
          record.donorId
            ? `Donor: <@${record.donorId}>`
            : `Donor: ${record.donorTag || 'Unknown'} _(link a Discord user if needed)_`,
        ].join('\n')
      )
      .addFields(
        { name: 'Method', value: record.methodLabel || '—', inline: true },
        { name: 'Amount', value: money(record.amount, symbol), inline: true },
        { name: 'Status', value: statusLabel(record), inline: true }
      ),
    guildConfig,
    {
      color: statusColor(record),
      context: 'Donations',
      timestamp: record.createdAt ? new Date(record.createdAt) : new Date(),
    }
  );

  if (record.paypalTransactionId) {
    embed.addFields({
      name: 'PayPal',
      value: [
        `Txn \`${record.paypalTransactionId}\``,
        record.paypalPayerEmail ? `Email: ${record.paypalPayerEmail}` : null,
        record.paypalPayerName ? `Name: ${record.paypalPayerName}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }
  if (record.stripePaymentIntentId) {
    embed.addFields({
      name: 'Stripe',
      value: [
        `PI \`${record.stripePaymentIntentId}\``,
        record.stripeReceiptEmail
          ? `Email: ${record.stripeReceiptEmail}`
          : null,
        record.stripeCurrency ? `Currency: ${record.stripeCurrency}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }
  if (record.methodLink) {
    embed.addFields({ name: 'Link', value: record.methodLink });
  }
  if (record.note) {
    embed.addFields({ name: 'Note', value: record.note });
  }
  if (record.receivedAt) {
    embed.addFields({
      name: 'Received',
      value: `<t:${Math.floor(new Date(record.receivedAt).getTime() / 1000)}:f>${
        record.receivedByTag ? ` · ${record.receivedByTag}` : ''
      }`,
    });
  }
  if (record.deliveredAt) {
    embed.addFields({
      name: 'Delivered',
      value: `<t:${Math.floor(new Date(record.deliveredAt).getTime() / 1000)}:f>${
        record.deliveredByTag ? ` · ${record.deliveredByTag}` : ''
      }`,
    });
  }

  return embed;
}

function donationLogComponents(record) {
  const row = new ActionRowBuilder();
  if (record.status === 'pending' || !record.confirmed) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`donate:received:${record.id}`)
        .setLabel('Mark as Received')
        .setStyle(ButtonStyle.Primary)
    );
  }
  if (!record.donorId && record.status !== 'delivered') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`donate:link:${record.id}`)
        .setLabel('Link Discord donor')
        .setStyle(ButtonStyle.Secondary)
    );
  }
  if (record.status !== 'delivered') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`donate:delivered:${record.id}`)
        .setLabel('Mark as Delivered')
        .setStyle(ButtonStyle.Success)
        .setDisabled(record.status === 'pending' || !record.confirmed)
    );
  }
  if (!row.components.length) return [];
  return [row];
}

async function postDonationLog(discordGuild, record) {
  const guildConfig = getGuild(discordGuild.id);
  const embed = buildDonationLogEmbed(record, guildConfig);
  const components = donationLogComponents(record);

  let forum;
  try {
    forum = await ensureDonationLogForum(discordGuild);
  } catch (error) {
    return { ok: false, reason: error.message, embed };
  }

  const who =
    discordGuild.members.cache.get(record.donorId)?.displayName ||
    record.donorTag ||
    'donor';

  const thread = await forum.threads.create({
    name: `${money(record.amount, getAdminPay(discordGuild.id).currencySymbol || '£')} · ${who}`.slice(
      0,
      100
    ),
    message: { embeds: [embed], components },
  });

  const starter = thread.lastMessageId
    ? await thread.messages.fetch(thread.lastMessageId).catch(() => null)
    : null;

  updateDonation(discordGuild.id, record.id, {
    logThreadId: thread.id,
    logMessageId: starter?.id || null,
  });

  return {
    ok: true,
    threadId: thread.id,
    messageId: starter?.id || null,
    embed,
    record: { ...record, logThreadId: thread.id },
  };
}

async function refreshDonationLogMessage(discordGuild, record) {
  if (!record.logThreadId) return { ok: false, reason: 'no_thread' };
  const guildConfig = getGuild(discordGuild.id);
  const thread = await discordGuild.channels.fetch(record.logThreadId).catch(() => null);
  if (!thread) return { ok: false, reason: 'missing_thread' };

  const embed = buildDonationLogEmbed(record, guildConfig);
  const components = donationLogComponents(record);

  let message = null;
  if (record.logMessageId) {
    message = await thread.messages.fetch(record.logMessageId).catch(() => null);
  }
  if (!message) {
    message = await thread.fetchStarterMessage().catch(() => null);
  }
  if (!message) return { ok: false, reason: 'missing_message' };

  await message.edit({ embeds: [embed], components });
  return { ok: true };
}

module.exports = {
  ensureDonationLogForum,
  buildDonationLogEmbed,
  donationLogComponents,
  postDonationLog,
  refreshDonationLogMessage,
};

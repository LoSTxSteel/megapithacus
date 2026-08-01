const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const {
  getAdminPay,
  money,
  activitySummaryLines,
  pendingRequestCount,
  formatPaymentDetails,
  paymentMethodSummaryLines,
} = require('./adminPay');
const { brandEmbed } = require('../utils/embeds');
const { getGuild } = require('./storage');

const BOARD_EVENT_BTN = 'payboard:event';
const BOARD_PAY_BTN = 'payboard:payout';
const BOARD_PAY_METHOD_SELECT = 'payboard:pay-method';
const BOARD_TYPE_SELECT = 'payboard:type';
const BOARD_PHOTOS_SKIP = 'payboard:photos:skip';
const BOARD_PHOTOS_DONE = 'payboard:photos:done';
/** @deprecated */
const BOARD_REQUEST_BTN = BOARD_EVENT_BTN;

function payBoardEmbed(guildId) {
  const guild = getGuild(guildId);
  const pay = getAdminPay(guildId);
  const pendingEvents = pendingRequestCount(pay, 'event');
  const pendingPayouts = pendingRequestCount(pay, 'payout');

  return brandEmbed(
    new EmbedBuilder()
      .setTitle('Admin Pay')
      .setDescription(
        [
          'Staff on the pay roster can submit from here. Managers approve in the **Admin Pay** forum.',
          '',
          '**Log complete event**',
          'Event type, date & time, attendance, then photo proof via **bot DM**.',
          '',
          '**Request pay**',
          'Ask for a payout using one of the accepted methods below.',
          '',
          '**Event payouts**',
          ...activitySummaryLines(pay),
          '',
          '**Payout methods**',
          ...paymentMethodSummaryLines(pay),
          '',
          `_Pending · events **${pendingEvents}** · pay requests **${pendingPayouts}**_`,
        ].join('\n')
      ),
    guild,
    { context: 'Admin Pay' }
  );
}

function payBoardComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(BOARD_EVENT_BTN)
        .setLabel('Log complete event')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(BOARD_PAY_BTN)
        .setLabel('Request pay')
        .setStyle(ButtonStyle.Success)
    ),
  ];
}

function payBoardPayload(guildId) {
  return {
    embeds: [payBoardEmbed(guildId)],
    components: payBoardComponents(),
  };
}

function requestReviewEmbed(guild, request, { requesterTag } = {}) {
  const pay = getAdminPay(guild.id || request.guildId);
  const kind = request.kind || 'event';
  const isPayout = kind === 'payout';
  const who = requesterTag || `<@${request.userId}>`;

  const embed = new EmbedBuilder()
    .setTitle(isPayout ? 'Pay request' : 'Event review')
    .setDescription(
      isPayout
        ? `${who} requested a payout.`
        : `${who} logged a completed event.`
    )
    .addFields({ name: 'Staff', value: `<@${request.userId}>`, inline: true });

  if (isPayout) {
    embed.addFields(
      {
        name: 'Amount',
        value: money(pay, request.amount),
        inline: true,
      },
      {
        name: 'Method',
        value: request.paymentMethodLabel || request.paymentMethod || '—',
        inline: true,
      },
      {
        name: 'Details',
        value: formatPaymentDetails(request).join('\n').slice(0, 1024),
      }
    );
  } else {
    embed.addFields(
      {
        name: 'Event',
        value: request.activityLabel || request.activity || '—',
        inline: true,
      },
      {
        name: 'Payout',
        value: money(pay, request.amount),
        inline: true,
      },
      { name: 'Hosted', value: request.hostedAt || '—', inline: true },
      {
        name: 'Attendance',
        value: String(request.attendance ?? '—'),
        inline: true,
      }
    );

    const photos = request.photos || [];
    if (photos.length && photos[0]?.url) {
      embed.setImage(photos[0].url);
      if (photos.length > 1) {
        embed.addFields({
          name: 'Photos',
          value: `${photos.length} attached`,
          inline: true,
        });
      }
    }
  }

  if (request.note) {
    embed.addFields({ name: 'Notes', value: request.note });
  }

  embed.addFields({
    name: 'Submitted',
    value: `<t:${Math.floor(new Date(request.createdAt).getTime() / 1000)}:R>`,
    inline: true,
  });

  return brandEmbed(embed, getGuild(request.guildId), {
    color: isPayout ? 0x22c55e : 0xf59e0b,
    context: 'Admin Pay',
  });
}

/** Extra embeds for additional event photos (first is on the main review embed). */
function requestPhotoEmbeds(request) {
  const photos = (request.photos || []).slice(1, 5);
  return photos
    .filter((p) => p?.url)
    .map((p, i) =>
      brandEmbed(
        new EmbedBuilder().setTitle(`Photo ${i + 2}`).setImage(p.url),
        getGuild(request.guildId),
        { color: 0xf59e0b, context: 'Admin Pay' }
      )
    );
}

function requestReviewComponents(requestId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`payreq:approve:${requestId}`)
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`payreq:deny:${requestId}`)
        .setLabel('Deny')
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

module.exports = {
  BOARD_EVENT_BTN,
  BOARD_PAY_BTN,
  BOARD_PAY_METHOD_SELECT,
  BOARD_PHOTOS_SKIP,
  BOARD_PHOTOS_DONE,
  BOARD_REQUEST_BTN,
  BOARD_TYPE_SELECT,
  payBoardEmbed,
  payBoardComponents,
  payBoardPayload,
  requestReviewEmbed,
  requestPhotoEmbeds,
  requestReviewComponents,
};

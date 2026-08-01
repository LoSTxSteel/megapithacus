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
} = require('./adminPay');
const { footerForGuild, colorForGuild } = require('../utils/embeds');
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

  return new EmbedBuilder()
    .setColor(colorForGuild(guild))
    .setTitle('Admin Pay · Staff board')
    .setDescription(
      [
        'Rostered staff can submit from this board. Managers approve in the **pay-logging** forum.',
        '',
        '**Log complete event**',
        'Submit event type, date & time hosted, attendance, then send photo proof in a **DM to the bot**.',
        'When a manager approves, the event payout is added to your owed balance.',
        '',
        '**Request pay**',
        'Ask managers to pay out some or all of your owed balance.',
        'You must choose a method: **PayPal**, **Bank transfer (UK only)**, or **Gift card**.',
        '',
        '**Event payouts (if approved)**',
        ...activitySummaryLines(pay),
        '',
        `_Pending events: **${pendingEvents}** · Pending pay requests: **${pendingPayouts}**_`,
      ].join('\n')
    )
    .setFooter({ text: `${footerForGuild(guild)} · Pay board` })
    .setTimestamp();
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

  const embed = new EmbedBuilder()
    .setColor(isPayout ? 0x2ecc71 : 0xf39c12)
    .setTitle(
      isPayout
        ? 'Pay request · pending approval'
        : 'Completed event · pending approval'
    )
    .setDescription(
      [
        `**${requesterTag || `<@${request.userId}>`}** ${
          isPayout
            ? 'requested a payout.'
            : 'logged a completed event.'
        }`,
        'Managers with **Admin Pay** access can approve or deny.',
      ].join('\n')
    )
    .addFields({ name: 'Admin', value: `<@${request.userId}>`, inline: true });

  if (isPayout) {
    embed.addFields(
      {
        name: 'Amount requested',
        value: money(pay, request.amount),
        inline: true,
      },
      {
        name: 'Balance when requested',
        value:
          request.balanceAtRequest != null
            ? money(pay, request.balanceAtRequest)
            : '—',
        inline: true,
      },
      {
        name: 'Payment method',
        value: request.paymentMethodLabel || request.paymentMethod || '—',
        inline: true,
      },
      {
        name: 'Payment details',
        value: formatPaymentDetails(request).join('\n').slice(0, 1024),
      }
    );
  } else {
    embed.addFields(
      {
        name: 'Event type',
        value: request.activityLabel || request.activity || '—',
        inline: true,
      },
      {
        name: 'Amount if approved',
        value: money(pay, request.amount),
        inline: true,
      },
      { name: 'Date & time hosted', value: request.hostedAt || '—' },
      {
        name: 'Attendance',
        value: String(request.attendance ?? '—'),
        inline: true,
      }
    );

    const photos = request.photos || [];
    if (photos.length) {
      embed.addFields({
        name: 'Photos',
        value: `${photos.length} attached (see below)`,
        inline: true,
      });
      if (photos[0]?.url) {
        embed.setImage(photos[0].url);
      }
    } else {
      embed.addFields({
        name: 'Photos',
        value: '_None_',
        inline: true,
      });
    }
  }

  if (request.note) {
    embed.addFields({ name: 'Notes', value: request.note });
  }

  embed
    .addFields({
      name: 'Submitted',
      value: `<t:${Math.floor(new Date(request.createdAt).getTime() / 1000)}:f>`,
      inline: true,
    })
    .setFooter({ text: `${footerForGuild(getGuild(request.guildId))} · Pay board` })
    .setTimestamp();

  return embed;
}

/** Extra embeds for additional event photos (first is on the main review embed). */
function requestPhotoEmbeds(request) {
  const photos = (request.photos || []).slice(1, 5);
  return photos
    .filter((p) => p?.url)
    .map((p, i) =>
      new EmbedBuilder()
        .setColor(0xf39c12)
        .setTitle(`Event photo ${i + 2}`)
        .setImage(p.url)
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

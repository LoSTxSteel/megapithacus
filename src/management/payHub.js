const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const {
  getAdminPay,
  money,
  getUserBalance,
  logEventHost,
  logTicketWork,
  createPayoutRequest,
} = require('../services/adminPay');
const { canUsePay } = require('../services/guildPermissions');
const { guildEmbed, errorEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');
const { ADMIN_ROLE_NAME } = require('../services/botSetup');

const PREFIX = 'payhub:';

function denyPay(interaction) {
  const payload = {
    embeds: [
      errorEmbed(
        `You do not have permission to use Admin Pay.\n` +
          `Need a configured **/pay** role, **Manage Server**, or the **${ADMIN_ROLE_NAME}** role.`
      ),
    ],
    ...EPHEMERAL,
  };
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(payload);
  }
  return interaction.reply(payload);
}

function balanceSummary(guildId, userId) {
  const pay = getAdminPay(guildId);
  const bal = getUserBalance(guildId, userId);
  return [
    `**Total balance:** ${money(pay, bal.balance)}`,
    `Available to request: **${money(pay, bal.available)}**`,
    `Pending requests: **${money(pay, bal.pending)}** · Paid out: **${money(pay, bal.paidOut)}**`,
  ].join('\n');
}

function buildPayMessage(guildId, userId, { content = null } = {}) {
  const guild = getGuild(guildId);
  const pay = getAdminPay(guildId);
  const options = [
    {
      label: 'Apply for money',
      description: 'Request a payout of your available balance',
      value: 'apply',
    },
    {
      label: 'Log completed event',
      description: `Credit ${money(pay, pay.eventHostPayAmount)} for hosting an event`,
      value: 'log-event',
    },
  ];

  if (pay.ticketPayAmount > 0) {
    options.push({
      label: 'Log ticket work',
      description: `Credit ${money(pay, pay.ticketPayAmount)} for ticket system work`,
      value: 'log-ticket',
    });
  }

  return {
    embeds: [
      guildEmbed(guild, 'Admin Pay', { context: 'Admin Pay' }).setDescription(
        [
          'Track what you have earned and request payouts.',
          '',
          balanceSummary(guildId, userId),
          '',
          `Event hosting rate: **${money(pay, pay.eventHostPayAmount)}**`,
          pay.ticketPayAmount > 0
            ? `Ticket work rate: **${money(pay, pay.ticketPayAmount)}**`
            : 'Ticket work rate: _not configured_',
          '',
          'Pick an action below.',
        ].join('\n')
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${PREFIX}action`)
          .setPlaceholder('Pay actions')
          .addOptions(options)
      ),
    ],
    content,
    ...EPHEMERAL,
  };
}

function applyModal(available, symbol) {
  const amountInput = new TextInputBuilder()
    .setCustomId('amount')
    .setLabel(`Amount (available ${symbol}${available})`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(12)
    .setPlaceholder(String(available || '0'));

  if (available > 0) {
    amountInput.setValue(String(available).slice(0, 12));
  }

  return new ModalBuilder()
    .setCustomId(`${PREFIX}modal:apply`)
    .setTitle('Apply for money')
    .addComponents(
      new ActionRowBuilder().addComponents(amountInput),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('note')
          .setLabel('Note (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(200)
          .setPlaceholder('e.g. PayPal / bank details hint')
      )
    );
}

function eventModal() {
  return new ModalBuilder()
    .setCustomId(`${PREFIX}modal:event`)
    .setTitle('Log completed event')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('note')
          .setLabel('Event note (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(200)
          .setPlaceholder('e.g. Friday tribe wars')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('date')
          .setLabel('Date (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(40)
          .setPlaceholder('e.g. 2026-08-02')
      )
    );
}

function ticketModal() {
  return new ModalBuilder()
    .setCustomId(`${PREFIX}modal:ticket`)
    .setTitle('Log ticket work')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('note')
          .setLabel('Note (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(200)
          .setPlaceholder('e.g. Closed 3 tickets')
      )
    );
}

async function handlePayInteraction(interaction) {
  const id = interaction.customId;
  if (!id?.startsWith(PREFIX)) return false;

  if (!canUsePay(interaction)) {
    await denyPay(interaction);
    return true;
  }

  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  if (interaction.isButton() && id === `${PREFIX}back`) {
    await interaction.update(buildPayMessage(guildId, userId));
    return true;
  }

  if (interaction.isStringSelectMenu() && id === `${PREFIX}action`) {
    const action = interaction.values[0];
    const pay = getAdminPay(guildId);

    if (action === 'apply') {
      const bal = getUserBalance(guildId, userId);
      if (bal.available <= 0) {
        await interaction.update(
          buildPayMessage(guildId, userId, {
            content: 'You have no available balance to request.',
          })
        );
        return true;
      }
      await interaction.showModal(
        applyModal(bal.available, pay.currencySymbol || '£')
      );
      return true;
    }

    if (action === 'log-event') {
      if (!(pay.eventHostPayAmount > 0)) {
        await interaction.update(
          buildPayMessage(guildId, userId, {
            content:
              'Event hosting pay is not configured. Ask a manager to set it in `/adminpay`.',
          })
        );
        return true;
      }
      await interaction.showModal(eventModal());
      return true;
    }

    if (action === 'log-ticket') {
      if (!(pay.ticketPayAmount > 0)) {
        await interaction.update(
          buildPayMessage(guildId, userId, {
            content: 'Ticket system pay is not configured yet.',
          })
        );
        return true;
      }
      await interaction.showModal(ticketModal());
      return true;
    }
  }

  if (interaction.isModalSubmit() && id === `${PREFIX}modal:apply`) {
    const amount = interaction.fields.getTextInputValue('amount');
    const note = interaction.fields.getTextInputValue('note') || null;
    const result = createPayoutRequest(guildId, userId, amount, note);
    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error)],
        ...EPHEMERAL,
      });
      return true;
    }
    await interaction.reply({
      ...buildPayMessage(guildId, userId),
      content: `Payout request for **${money(result.pay, result.request.amount)}** submitted. Managers review it in \`/adminpay\`.`,
    });
    return true;
  }

  if (interaction.isModalSubmit() && id === `${PREFIX}modal:event`) {
    const note = interaction.fields.getTextInputValue('note') || null;
    const date = interaction.fields.getTextInputValue('date') || null;
    const result = logEventHost(guildId, userId, { note, date });
    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error)],
        ...EPHEMERAL,
      });
      return true;
    }
    await interaction.reply({
      ...buildPayMessage(guildId, userId),
      content: `Logged event hosting · **${money(result.pay, result.entry.amount)}** added.`,
    });
    return true;
  }

  if (interaction.isModalSubmit() && id === `${PREFIX}modal:ticket`) {
    const note = interaction.fields.getTextInputValue('note') || null;
    const result = logTicketWork(guildId, userId, { note });
    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error)],
        ...EPHEMERAL,
      });
      return true;
    }
    await interaction.reply({
      ...buildPayMessage(guildId, userId),
      content: `Logged ticket work · **${money(result.pay, result.entry.amount)}** added.`,
    });
    return true;
  }

  return true;
}

module.exports = {
  buildPayMessage,
  handlePayInteraction,
};

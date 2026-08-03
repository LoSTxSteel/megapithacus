const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const {
  getAdminPay,
  money,
  configSummary,
  setTicketPayAmount,
  setEventHostPayAmount,
  setPayRoleIds,
  listPendingPayouts,
  approvePayoutRequest,
  denyPayoutRequest,
} = require('../services/adminPay');
const { canManageAdminPay } = require('../services/guildPermissions');
const { guildEmbed, errorEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');
const { ADMIN_ROLE_NAME } = require('../services/botSetup');
const { syncPayCommandPermissions } = require('../services/payCommandPermissions');

const PREFIX = 'adminpayhub:';

function denyAdminPay(interaction) {
  const payload = {
    embeds: [
      errorEmbed(
        `You do not have permission to manage Admin Pay.\n` +
          `Need **Manage Server**, the **${ADMIN_ROLE_NAME}** role, or a role granted under **Admin Pay** (\`/permissions\`).`
      ),
    ],
    ...EPHEMERAL,
  };
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(payload);
  }
  return interaction.reply(payload);
}

function backAdminPay() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}back`)
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildAdminPayMessage(guildId, { content = null } = {}) {
  const guild = getGuild(guildId);
  const pending = listPendingPayouts(guildId).length;

  return {
    embeds: [
      guildEmbed(guild, 'Admin Pay', { context: 'Admin Pay' }).setDescription(
        [
          'Configure admin pay rates and review payout requests.',
          '',
          configSummary(guildId),
          '',
          'Pick an action below.',
        ].join('\n')
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${PREFIX}action`)
          .setPlaceholder('Admin Pay actions')
          .addOptions(
            {
              label: 'Configure ticket system pay',
              description: 'Amount when ticket work is done (config for later)',
              value: 'ticket-pay',
            },
            {
              label: 'Configure event hosting pay',
              description: 'Amount paid for hosting an event',
              value: 'event-pay',
            },
            {
              label: 'Set roles that can use /pay',
              description: 'Which roles can log work and request payouts',
              value: 'pay-roles',
            },
            {
              label: 'Review payout requests',
              description:
                pending > 0
                  ? `${pending} pending request(s)`
                  : 'Approve or deny pending payouts',
              value: 'review-payouts',
            }
          )
      ),
    ],
    content,
    ...EPHEMERAL,
  };
}

function amountModal(customId, title, current) {
  const input = new TextInputBuilder()
    .setCustomId('amount')
    .setLabel('Amount')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(12)
    .setPlaceholder('e.g. 5 or 12.50');

  if (current != null && String(current).length) {
    input.setValue(String(current).slice(0, 12));
  }

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function payRolesPanel(guildId) {
  const pay = getAdminPay(guildId);
  const select = new RoleSelectMenuBuilder()
    .setCustomId(`${PREFIX}roles`)
    .setPlaceholder('Roles that can use /pay')
    .setMinValues(0)
    .setMaxValues(15);

  if (pay.payRoleIds.length) {
    select.setDefaultRoles(pay.payRoleIds.slice(0, 15));
  }

  return {
    embeds: [
      guildEmbed(getGuild(guildId), 'Set /pay roles', {
        context: 'Admin Pay',
      }).setDescription(
        [
          'Members with these roles can use `/pay` to log events/tickets and request payouts.',
          'Manage Server and the bot setup role always can.',
          '',
          `Current: ${
            pay.payRoleIds.length
              ? pay.payRoleIds.map((id) => `<@&${id}>`).join(', ')
              : '_None_'
          }`,
          '',
          'Select roles and submit. Submit with none selected to clear.',
        ].join('\n')
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(select),
      backAdminPay(),
    ],
    content: null,
  };
}

function reviewPayoutsPanel(guildId) {
  const pay = getAdminPay(guildId);
  const pending = listPendingPayouts(guildId);

  if (!pending.length) {
    return buildAdminPayMessage(guildId, {
      content: 'No pending payout requests.',
    });
  }

  const lines = pending.slice(0, 20).map((r) => {
    const when = r.createdAt
      ? `<t:${Math.floor(new Date(r.createdAt).getTime() / 1000)}:R>`
      : '';
    const note = r.note ? ` — ${r.note}` : '';
    return `• <@${r.userId}> · **${money(pay, r.amount)}** ${when}${note}`;
  });

  return {
    embeds: [
      guildEmbed(getGuild(guildId), 'Review payout requests', {
        context: 'Admin Pay',
      }).setDescription(
        [
          'Select a request to approve (mark paid) or deny.',
          '',
          lines.join('\n'),
        ].join('\n')
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${PREFIX}payout:pick`)
          .setPlaceholder('Select a payout request')
          .addOptions(
            pending.slice(0, 25).map((r) => ({
              label: `${money(pay, r.amount)} · ${r.userId}`.slice(0, 100),
              description: (r.note || 'No note').slice(0, 100),
              value: r.id,
            }))
          )
      ),
      backAdminPay(),
    ],
    content: null,
  };
}

function payoutDecisionPanel(guildId, requestId) {
  const pay = getAdminPay(guildId);
  const request = pay.payoutRequests.find((r) => r.id === requestId);
  if (!request || request.status !== 'pending') {
    return buildAdminPayMessage(guildId, {
      content: 'That payout request is no longer pending.',
    });
  }

  const note = request.note ? `\nNote: ${request.note}` : '';

  return {
    embeds: [
      guildEmbed(getGuild(guildId), 'Payout request', {
        context: 'Admin Pay',
      }).setDescription(
        [
          `Requester: <@${request.userId}>`,
          `Amount: **${money(pay, request.amount)}**`,
          note,
          '',
          '**Approve** marks it paid and reduces their balance.',
          '**Deny** rejects the request (balance stays available).',
        ]
          .filter(Boolean)
          .join('\n')
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${PREFIX}payout:decide:${requestId}`)
          .setPlaceholder('Approve or deny')
          .addOptions(
            {
              label: 'Approve (mark paid)',
              description: 'Reduce balance and close the request',
              value: 'approve',
            },
            {
              label: 'Deny',
              description: 'Reject without paying',
              value: 'deny',
            }
          )
      ),
      backAdminPay(),
    ],
    content: null,
  };
}

async function handleAdminPayInteraction(interaction) {
  const id = interaction.customId;
  if (!id?.startsWith(PREFIX)) return false;

  if (!canManageAdminPay(interaction)) {
    await denyAdminPay(interaction);
    return true;
  }

  const guildId = interaction.guildId;

  if (interaction.isButton() && id === `${PREFIX}back`) {
    await interaction.update(buildAdminPayMessage(guildId));
    return true;
  }

  if (interaction.isStringSelectMenu() && id === `${PREFIX}action`) {
    const action = interaction.values[0];
    const pay = getAdminPay(guildId);

    if (action === 'ticket-pay') {
      await interaction.showModal(
        amountModal(
          `${PREFIX}modal:ticket`,
          'Ticket system pay',
          pay.ticketPayAmount
        )
      );
      return true;
    }

    if (action === 'event-pay') {
      await interaction.showModal(
        amountModal(
          `${PREFIX}modal:event`,
          'Event hosting pay',
          pay.eventHostPayAmount
        )
      );
      return true;
    }

    if (action === 'pay-roles') {
      await interaction.update(payRolesPanel(guildId));
      return true;
    }

    if (action === 'review-payouts') {
      await interaction.update(reviewPayoutsPanel(guildId));
      return true;
    }
  }

  if (interaction.isRoleSelectMenu() && id === `${PREFIX}roles`) {
    setPayRoleIds(guildId, interaction.values);
    let syncNote = '';
    try {
      const sync = await syncPayCommandPermissions(interaction.guild);
      if (sync.ok) {
        syncNote = ` Synced /pay visibility for ${sync.roleAllows} role(s).`;
      } else if (sync.reason === 'no_bearer') {
        syncNote =
          ' /pay stays Administrator-only in Discord until `DISCORD_COMMAND_PERMISSIONS_TOKEN` is set, or an admin enables the selected roles under **Server Settings → Integrations → Megapithacus → /pay**. Execute checks still enforce pay roles.';
      } else if (sync.error) {
        syncNote = ` Visibility sync note: ${sync.error}`;
      }
    } catch (error) {
      syncNote = ` Visibility sync failed: ${error.message}`;
    }

    await interaction.update(
      buildAdminPayMessage(guildId, {
        content: interaction.values.length
          ? `Updated /pay roles (${interaction.values.length}).${syncNote}`
          : `Cleared /pay roles.${syncNote}`,
      })
    );
    return true;
  }

  if (interaction.isStringSelectMenu() && id === `${PREFIX}payout:pick`) {
    await interaction.update(payoutDecisionPanel(guildId, interaction.values[0]));
    return true;
  }

  if (interaction.isStringSelectMenu() && id.startsWith(`${PREFIX}payout:decide:`)) {
    const requestId = id.slice(`${PREFIX}payout:decide:`.length);
    const choice = interaction.values[0];
    const result =
      choice === 'approve'
        ? approvePayoutRequest(guildId, requestId, interaction.user.id)
        : denyPayoutRequest(guildId, requestId, interaction.user.id);

    if (!result.ok) {
      await interaction.update(
        buildAdminPayMessage(guildId, { content: result.error })
      );
      return true;
    }

    const pay = getAdminPay(guildId);
    const verb = choice === 'approve' ? 'Approved' : 'Denied';
    await interaction.update(
      buildAdminPayMessage(guildId, {
        content: `${verb} payout of ${money(pay, result.request.amount)} for <@${result.request.userId}>.`,
      })
    );
    return true;
  }

  if (interaction.isModalSubmit() && id === `${PREFIX}modal:ticket`) {
    const result = setTicketPayAmount(
      guildId,
      interaction.fields.getTextInputValue('amount')
    );
    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error)],
        ...EPHEMERAL,
      });
      return true;
    }
    await interaction.reply({
      ...buildAdminPayMessage(guildId),
      content: `Ticket system pay set to **${money(result.pay, result.amount)}** (stored for when tickets are set up).`,
    });
    return true;
  }

  if (interaction.isModalSubmit() && id === `${PREFIX}modal:event`) {
    const result = setEventHostPayAmount(
      guildId,
      interaction.fields.getTextInputValue('amount')
    );
    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error)],
        ...EPHEMERAL,
      });
      return true;
    }
    await interaction.reply({
      ...buildAdminPayMessage(guildId),
      content: `Event hosting pay set to **${money(result.pay, result.amount)}** per event.`,
    });
    return true;
  }

  return true;
}

module.exports = {
  buildAdminPayMessage,
  handleAdminPayInteraction,
};

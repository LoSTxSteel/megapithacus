const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const {
  getAdminPay,
  setCurrency,
  setActivityAmount,
  upsertStaff,
  removeStaff,
  addCredit,
  recordPayout,
  money,
  staffSummaryLines,
  activitySummaryLines,
  ledgerSummaryLines,
  listEnabledActivities,
  findStaff,
} = require('../services/adminPay');
const { guildEmbed, errorEmbed } = require('../utils/embeds');
const { canManageAdminPay } = require('../services/guildPermissions');
const { logPayEvent, ensurePayApprovalForum } = require('../services/payLog');
const { payBoardPayload } = require('../services/payBoard');
const { getGuild } = require('../services/storage');

async function maybeLogPay(interaction, entry) {
  if (!entry || !interaction.guild) return;
  try {
    await logPayEvent(interaction.guild, entry);
  } catch (error) {
    console.warn('Pay log failed:', error.message);
  }
}

function denyPay(interaction) {
  const payload = {
    embeds: [
      errorEmbed(
        'You do not have permission to manage **Admin Pay**.\n' +
          'Ask the server owner to grant your role with `/permissions set` → **Admin Pay**.'
      ),
    ],
    ephemeral: true,
  };
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(payload);
  }
  return interaction.reply(payload);
}

function payActionSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('adminpay:action')
      .setPlaceholder('Choose an Admin Pay action')
      .addOptions(
        {
          label: 'Post staff board',
          description: 'Post board + create approval forum',
          value: 'post-board',
        },
        {
          label: 'Add paid admin',
          description: 'Add a Discord user to the pay roster',
          value: 'add-staff',
        },
        {
          label: 'Remove paid admin',
          description: 'Remove someone from the pay roster',
          value: 'remove-staff',
        },
        {
          label: 'Set activity payouts',
          description: 'Discord event / in-game event amounts',
          value: 'activity-rates',
        },
        {
          label: 'Add bonus / credit',
          description: 'Flat amount added to balance',
          value: 'credit',
        },
        {
          label: 'Record payout',
          description: 'Mark an admin as paid (manual)',
          value: 'payout',
        },
        {
          label: 'Set currency',
          description: 'Currency code + symbol (e.g. GBP / £)',
          value: 'currency',
        }
      )
  );
}

function buildPayPanel(guildId) {
  const pay = getAdminPay(guildId);
  const guildLike = getGuild(guildId);

  const embed = guildEmbed(guildLike, 'Admin Pay')
    .setDescription(
      [
        'Track what you **owe admins** for completed work.',
        '',
        `Currency: **${pay.currencySymbol}** (${pay.currency})`,
        '1. Add staff to the roster',
        '2. Post the staff board (`/adminpay board` or action below)',
        '3. Approve completed events / pay requests in the pay-logging forum',
      ].join('\n')
    )
    .addFields(
      {
        name: 'Activity payouts',
        value: activitySummaryLines(pay).join('\n').slice(0, 1024),
      },
      {
        name: 'Roster',
        value: staffSummaryLines(pay).join('\n').slice(0, 1024),
      },
      {
        name: 'Recent ledger',
        value: ledgerSummaryLines(pay, 8).join('\n').slice(0, 1024),
      }
    );

  return {
    embeds: [embed],
    components: [payActionSelect()],
  };
}

function backPay() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('adminpay:back')
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );
}

function userPick(customId, placeholder) {
  return new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(1)
  );
}

function staffOptions(interaction, pay) {
  return pay.staff.slice(0, 25).map((s) => {
    const member = interaction.guild.members.cache.get(s.userId);
    const name =
      member?.displayName || member?.user?.username || `User ${s.userId}`;
    return {
      label: name.slice(0, 100),
      description: `Owed ${money(pay, s.balance)}`.slice(0, 100),
      value: s.userId,
    };
  });
}

async function handleAdminPayInteraction(interaction) {
  const id = interaction.customId;
  // Support new adminpay:* and legacy mgmt:pay* custom IDs
  const normalized = id
    ?.replace(/^mgmt:modal:pay-/, 'adminpay:modal:')
    .replace(/^mgmt:pay:/, 'adminpay:')
    .replace(/^mgmt:back:pay$/, 'adminpay:back');

  if (!normalized?.startsWith('adminpay:')) {
    return false;
  }

  if (!canManageAdminPay(interaction)) {
    await denyPay(interaction);
    return true;
  }

  const guildId = interaction.guildId;

  if (interaction.isButton() && normalized === 'adminpay:back') {
    await interaction.update({
      ...buildPayPanel(guildId),
      content: null,
    });
    return true;
  }

  if (interaction.isStringSelectMenu() && normalized === 'adminpay:action') {
    const action = interaction.values[0];

    if (action === 'post-board') {
      const pay = getAdminPay(guildId);
      if (!listEnabledActivities(pay).length) {
        await interaction.update({
          ...buildPayPanel(guildId),
          content:
            'No event types configured. Set activity payouts first.',
        });
        return true;
      }

      try {
        const forum = await ensurePayApprovalForum(interaction.guild);
        await interaction.channel.send(payBoardPayload(guildId));
        await interaction.update({
          ...buildPayPanel(guildId),
          content: `Staff board posted. Managers approve in <#${forum.id}>.`,
        });
      } catch (error) {
        await interaction.update({
          ...buildPayPanel(guildId),
          content: `Could not post board / create forum: ${error.message}`,
        });
      }
      return true;
    }

    if (action === 'currency') {
      const pay = getAdminPay(guildId);
      const modal = new ModalBuilder()
        .setCustomId('adminpay:modal:currency')
        .setTitle('Set pay currency')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('currency')
              .setLabel('Currency code')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(8)
              .setValue(pay.currency || 'GBP')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('symbol')
              .setLabel('Symbol')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(4)
              .setValue(pay.currencySymbol || '£')
          )
        );
      await interaction.showModal(modal);
      return true;
    }

    if (action === 'add-staff') {
      await interaction.update({
        embeds: [
          guildEmbed(getGuild(guildId), 'Add paid admin').setDescription(
            'Select a Discord user to add to the pay roster.\nThey can then use the staff board from `/adminpay board`.'
          ),
        ],
        components: [
          userPick('adminpay:pick:add', 'Select admin to add'),
          backPay(),
        ],
        content: null,
      });
      return true;
    }

    if (action === 'remove-staff') {
      const pay = getAdminPay(guildId);
      if (!pay.staff.length) {
        await interaction.update({
          ...buildPayPanel(guildId),
          content: 'No paid admins on the roster.',
        });
        return true;
      }
      await interaction.update({
        embeds: [
          guildEmbed(getGuild(guildId), 'Remove paid admin').setDescription(
            'Select a user to remove from the pay roster.'
          ),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('adminpay:select:remove')
              .setPlaceholder('Select admin to remove')
              .addOptions(staffOptions(interaction, pay))
          ),
          backPay(),
        ],
        content: null,
      });
      return true;
    }

    if (action === 'activity-rates') {
      const pay = getAdminPay(guildId);
      const activities = listEnabledActivities(pay);
      await interaction.update({
        embeds: [
          guildEmbed(getGuild(guildId), 'Set activity payouts').setDescription(
            [
              'Choose an activity to change its payout amount.',
              '',
              ...activitySummaryLines(pay),
            ].join('\n')
          ),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('adminpay:select:activity')
              .setPlaceholder('Select activity')
              .addOptions(
                activities.map((a) => ({
                  label: a.label.slice(0, 100),
                  description: `Current: ${money(pay, a.amount)}`.slice(0, 100),
                  value: a.value,
                }))
              )
          ),
          backPay(),
        ],
        content: null,
      });
      return true;
    }

    if (action === 'credit' || action === 'payout') {
      const pay = getAdminPay(guildId);
      if (!pay.staff.length) {
        await interaction.update({
          ...buildPayPanel(guildId),
          content: 'Add a paid admin first.',
        });
        return true;
      }
      const labels = {
        credit: 'Add bonus / credit',
        payout: 'Record payout',
      };
      await interaction.update({
        embeds: [
          guildEmbed(getGuild(guildId), labels[action]).setDescription(
            'Select the admin this applies to.'
          ),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`adminpay:select:${action}`)
              .setPlaceholder('Select paid admin')
              .addOptions(staffOptions(interaction, pay))
          ),
          backPay(),
        ],
        content: null,
      });
      return true;
    }
  }

  if (interaction.isUserSelectMenu() && normalized === 'adminpay:pick:add') {
    const userId = interaction.values[0];
    const modal = new ModalBuilder()
      .setCustomId(`adminpay:modal:add:${userId}`)
      .setTitle('Add paid admin')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('label')
            .setLabel('Optional label (e.g. Event Admin)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(64)
        )
      );
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isStringSelectMenu() && normalized === 'adminpay:select:remove') {
    const userId = interaction.values[0];
    removeStaff(guildId, userId);
    await interaction.update({
      ...buildPayPanel(guildId),
      content: `Removed <@${userId}> from the pay roster.`,
    });
    return true;
  }

  if (interaction.isStringSelectMenu() && normalized === 'adminpay:select:activity') {
    const activityValue = interaction.values[0];
    const pay = getAdminPay(guildId);
    const activity = pay.activities.find((a) => a.value === activityValue);
    const modal = new ModalBuilder()
      .setCustomId(`adminpay:modal:activity:${activityValue}`)
      .setTitle(`Payout · ${(activity?.label || 'Activity').slice(0, 30)}`)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('amount')
            .setLabel(`Amount (${pay.currencySymbol})`)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(activity ? String(activity.amount) : '10')
        )
      );
    await interaction.showModal(modal);
    return true;
  }

  if (
    interaction.isStringSelectMenu() &&
    (normalized === 'adminpay:select:credit' ||
      normalized === 'adminpay:select:payout')
  ) {
    const userId = interaction.values[0];
    const action = normalized.split(':').pop();
    const pay = getAdminPay(guildId);
    const staff = findStaff(pay, userId);
    if (!staff) {
      await interaction.update({
        ...buildPayPanel(guildId),
        content: 'That admin is no longer on the roster.',
      });
      return true;
    }

    if (action === 'credit') {
      const modal = new ModalBuilder()
        .setCustomId(`adminpay:modal:credit:${userId}`)
        .setTitle('Add bonus / credit')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('amount')
              .setLabel(`Amount (${pay.currencySymbol})`)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setPlaceholder('25')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('note')
              .setLabel('Note (optional)')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(100)
          )
        );
      await interaction.showModal(modal);
      return true;
    }

    if (action === 'payout') {
      const modal = new ModalBuilder()
        .setCustomId(`adminpay:modal:payout:${userId}`)
        .setTitle('Record payout')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('amount')
              .setLabel(`Amount (blank = full ${money(pay, staff.balance)})`)
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setPlaceholder(String(staff.balance || ''))
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('note')
              .setLabel('Note (optional)')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(100)
          )
        );
      await interaction.showModal(modal);
      return true;
    }
  }

  if (interaction.isModalSubmit() && normalized === 'adminpay:modal:currency') {
    const currency = interaction.fields.getTextInputValue('currency');
    const symbol = interaction.fields.getTextInputValue('symbol');
    setCurrency(guildId, { currency, currencySymbol: symbol });
    await interaction.reply({
      embeds: [
        guildEmbed(getGuild(guildId), 'Currency updated').setDescription(
          `Pay currency set to **${symbol.trim()}** (${currency.trim().toUpperCase()}).`
        ),
      ],
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isModalSubmit() && normalized.startsWith('adminpay:modal:add:')) {
    const userId = normalized.slice('adminpay:modal:add:'.length);
    const label = interaction.fields.getTextInputValue('label');
    const result = upsertStaff(guildId, { userId, label });
    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error)],
        ephemeral: true,
      });
      return true;
    }
    await maybeLogPay(interaction, {
      type: 'roster',
      userId,
      action: 'added to roster',
      byId: interaction.user.id,
      byTag: `${interaction.user}`,
    });
    await interaction.reply({
      embeds: [
        guildEmbed(getGuild(guildId), 'Paid admin added').setDescription(
          `<@${userId}> is on the pay roster and can use the board from \`/adminpay board\`.`
        ),
      ],
      ephemeral: true,
    });
    return true;
  }

  if (
    interaction.isModalSubmit() &&
    normalized.startsWith('adminpay:modal:activity:')
  ) {
    const activityValue = normalized.slice('adminpay:modal:activity:'.length);
    const amount = interaction.fields.getTextInputValue('amount');
    const result = setActivityAmount(guildId, activityValue, amount);
    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error)],
        ephemeral: true,
      });
      return true;
    }
    const pay = getAdminPay(guildId);
    await interaction.reply({
      embeds: [
        guildEmbed(getGuild(guildId), 'Activity payout updated').setDescription(
          `**${result.activity.label}** payout set to **${money(
            pay,
            result.activity.amount
          )}**.`
        ),
      ],
      ephemeral: true,
    });
    return true;
  }

  if (
    interaction.isModalSubmit() &&
    normalized.startsWith('adminpay:modal:credit:')
  ) {
    const userId = normalized.slice('adminpay:modal:credit:'.length);
    const amount = interaction.fields.getTextInputValue('amount');
    const note = interaction.fields.getTextInputValue('note');
    const result = addCredit(guildId, {
      userId,
      amount,
      note,
      byId: interaction.user.id,
      byTag: `${interaction.user}`,
    });
    if (!result.ok) {
      await interaction.reply({ embeds: [errorEmbed(result.error)], ephemeral: true });
      return true;
    }
    await maybeLogPay(interaction, result.entry);
    const pay = getAdminPay(guildId);
    await interaction.reply({
      embeds: [
        guildEmbed(getGuild(guildId), 'Credit applied').setDescription(
          `Applied **${money(pay, result.amount)}** to <@${userId}>.\nBalance owed: **${money(
            pay,
            result.balance
          )}**.`
        ),
      ],
      ephemeral: true,
    });
    return true;
  }

  if (
    interaction.isModalSubmit() &&
    normalized.startsWith('adminpay:modal:payout:')
  ) {
    const userId = normalized.slice('adminpay:modal:payout:'.length);
    const amount = interaction.fields.getTextInputValue('amount');
    const note = interaction.fields.getTextInputValue('note');
    const result = recordPayout(guildId, {
      userId,
      amount,
      note,
      byId: interaction.user.id,
      byTag: `${interaction.user}`,
    });
    if (!result.ok) {
      await interaction.reply({ embeds: [errorEmbed(result.error)], ephemeral: true });
      return true;
    }
    await maybeLogPay(interaction, result.entry);
    const pay = getAdminPay(guildId);
    await interaction.reply({
      embeds: [
        guildEmbed(getGuild(guildId), 'Payout recorded').setDescription(
          `Paid <@${userId}> **${money(pay, result.amount)}**.\nRemaining balance: **${money(
            pay,
            result.balance
          )}**.`
        ),
      ],
      ephemeral: true,
    });
    return true;
  }

  return false;
}

module.exports = {
  buildPayPanel,
  handleAdminPayInteraction,
};

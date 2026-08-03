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
const { EPHEMERAL } = require('../utils/ephemeral');
const {
  addCredit,
  removeCredit,
  wipeSeasonal,
  wipePermanent,
  getUserCredits,
} = require('../services/credits');
const { canManageCredits } = require('../services/guildPermissions');
const { guildEmbed, errorEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');

function denyCredits(interaction) {
  const payload = {
    embeds: [
      errorEmbed(
        'You do not have permission to manage credits.\n' +
          'Ask the server owner to grant your role with `/permissions` → **Credit manager**.'
      ),
    ],
    ...EPHEMERAL,
  };
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(payload);
  }
  return interaction.reply(payload);
}

function backCredits() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('credithub:back')
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );
}

function formatCredits(credits) {
  return `Seasonal: \`${credits.seasonal}\` · Permanent: \`${credits.permanent}\``;
}

function buildCreditManagerMessage(guildId, { content = null } = {}) {
  const guild = getGuild(guildId);
  return {
    embeds: [
      guildEmbed(guild, 'Credit Manager', { context: 'Credits' }).setDescription(
        [
          'Manage seasonal and permanent credit balances.',
          'Pick an action below.',
          '',
          'Destructive wipes ask for confirmation first.',
          'Balances can also be checked with `/credit` and `/creditview`.',
        ].join('\n')
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('credithub:action')
          .setPlaceholder('Credit manager actions')
          .addOptions(
            {
              label: 'Wipe seasonal credit',
              description: "Clear everyone's seasonal credit",
              value: 'wipe-seasonal',
            },
            {
              label: 'Wipe permanent credit',
              description: "Clear everyone's permanent credit",
              value: 'wipe-permanent',
            },
            {
              label: 'Add credit',
              description: 'Add seasonal or permanent credit to a user',
              value: 'add',
            },
            {
              label: 'Remove credit',
              description: 'Remove credit from a user (not below 0)',
              value: 'remove',
            },
            {
              label: 'View user balance',
              description: "Check a user's seasonal & permanent credit",
              value: 'view',
            }
          )
      ),
    ],
    content,
    ...EPHEMERAL,
  };
}

function amountModal(customId, title) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('amount')
          .setLabel('Amount')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(10)
          .setPlaceholder('e.g. 5')
      )
    );
}

function typePicker(guildId, customId, title, description) {
  return {
    embeds: [
      guildEmbed(getGuild(guildId), title, { context: 'Credits' }).setDescription(
        description
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(customId)
          .setPlaceholder('Seasonal or permanent')
          .addOptions(
            {
              label: 'Seasonal',
              description: 'Resets when you wipe seasonal credit',
              value: 'seasonal',
            },
            {
              label: 'Permanent',
              description: 'Kept until wiped or removed',
              value: 'permanent',
            }
          )
      ),
      backCredits(),
    ],
    content: null,
  };
}

function userPickerPanel(guildId, customId, title, description) {
  return {
    embeds: [
      guildEmbed(getGuild(guildId), title, { context: 'Credits' }).setDescription(
        description
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(customId)
          .setPlaceholder('Select user')
          .setMinValues(1)
          .setMaxValues(1)
      ),
      backCredits(),
    ],
    content: null,
  };
}

function wipeConfirmPanel(guildId, kind) {
  const label = kind === 'seasonal' ? 'seasonal' : 'permanent';
  return {
    embeds: [
      guildEmbed(getGuild(guildId), `Confirm wipe · ${label}`, {
        context: 'Credits',
      }).setDescription(
        [
          `This will set **everyone's** ${label} credit to \`0\`.`,
          'This cannot be undone from the bot.',
          '',
          'Select **Confirm wipe** to proceed, or go back.',
        ].join('\n')
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`credithub:confirm:wipe-${kind}`)
          .setPlaceholder('Confirm wipe?')
          .addOptions(
            {
              label: 'Confirm wipe',
              description: `Wipe all ${label} credit`,
              value: 'confirm',
            },
            {
              label: 'Cancel',
              description: 'Return without changes',
              value: 'cancel',
            }
          )
      ),
      backCredits(),
    ],
    content: null,
  };
}

async function handleCreditManagerInteraction(interaction) {
  const id = interaction.customId;
  if (!id?.startsWith('credithub:')) return false;

  if (!canManageCredits(interaction)) {
    await denyCredits(interaction);
    return true;
  }

  const guildId = interaction.guildId;
  const guild = getGuild(guildId);

  if (interaction.isButton() && id === 'credithub:back') {
    await interaction.update(buildCreditManagerMessage(guildId));
    return true;
  }

  if (interaction.isStringSelectMenu() && id === 'credithub:action') {
    const action = interaction.values[0];

    if (action === 'wipe-seasonal') {
      await interaction.update(wipeConfirmPanel(guildId, 'seasonal'));
      return true;
    }
    if (action === 'wipe-permanent') {
      await interaction.update(wipeConfirmPanel(guildId, 'permanent'));
      return true;
    }
    if (action === 'add') {
      await interaction.update(
        userPickerPanel(
          guildId,
          'credithub:user:add',
          'Add credit',
          'Select the user to receive credit.'
        )
      );
      return true;
    }
    if (action === 'remove') {
      await interaction.update(
        userPickerPanel(
          guildId,
          'credithub:user:remove',
          'Remove credit',
          'Select the user to remove credit from.'
        )
      );
      return true;
    }
    if (action === 'view') {
      await interaction.update(
        userPickerPanel(
          guildId,
          'credithub:user:view',
          'View balance',
          'Select a user to view their credit balance.'
        )
      );
      return true;
    }
  }

  if (interaction.isStringSelectMenu() && id.startsWith('credithub:confirm:wipe-')) {
    const kind = id.endsWith('seasonal') ? 'seasonal' : 'permanent';
    const choice = interaction.values[0];
    if (choice === 'cancel') {
      await interaction.update(buildCreditManagerMessage(guildId, { content: 'Wipe cancelled.' }));
      return true;
    }

    const result = kind === 'seasonal' ? wipeSeasonal(guildId) : wipePermanent(guildId);
    await interaction.update(
      buildCreditManagerMessage(guildId, {
        content: `Cleared ${kind} credit for \`${result.wiped}\` user(s).`,
      })
    );
    return true;
  }

  if (interaction.isUserSelectMenu() && id === 'credithub:user:view') {
    const userId = interaction.values[0];
    const credits = getUserCredits(guildId, userId);
    await interaction.update(
      buildCreditManagerMessage(guildId, {
        content: null,
      })
    );
    await interaction.followUp({
      embeds: [
        guildEmbed(guild, 'Credit balance', { context: 'Credits' }).setDescription(
          [`User: <@${userId}>`, formatCredits(credits)].join('\n')
        ),
      ],
      ...EPHEMERAL,
    });
    return true;
  }

  if (interaction.isUserSelectMenu() && id === 'credithub:user:add') {
    const userId = interaction.values[0];
    await interaction.update(
      typePicker(
        guildId,
        `credithub:type:add:${userId}`,
        'Add credit · type',
        `Add credit to <@${userId}>.\nChoose seasonal or permanent.`
      )
    );
    return true;
  }

  if (interaction.isUserSelectMenu() && id === 'credithub:user:remove') {
    const userId = interaction.values[0];
    await interaction.update(
      typePicker(
        guildId,
        `credithub:type:remove:${userId}`,
        'Remove credit · type',
        `Remove credit from <@${userId}>.\nChoose seasonal or permanent.`
      )
    );
    return true;
  }

  if (interaction.isStringSelectMenu() && id.startsWith('credithub:type:add:')) {
    const userId = id.slice('credithub:type:add:'.length);
    const type = interaction.values[0];
    await interaction.showModal(
      amountModal(`credithub:modal:add:${userId}:${type}`, 'Add credit · amount')
    );
    return true;
  }

  if (interaction.isStringSelectMenu() && id.startsWith('credithub:type:remove:')) {
    const userId = id.slice('credithub:type:remove:'.length);
    const type = interaction.values[0];
    await interaction.showModal(
      amountModal(`credithub:modal:remove:${userId}:${type}`, 'Remove credit · amount')
    );
    return true;
  }

  if (interaction.isModalSubmit() && id.startsWith('credithub:modal:add:')) {
    const rest = id.slice('credithub:modal:add:'.length);
    const lastColon = rest.lastIndexOf(':');
    const userId = rest.slice(0, lastColon);
    const type = rest.slice(lastColon + 1);
    const amountRaw = interaction.fields.getTextInputValue('amount');
    const result = addCredit(guildId, userId, amountRaw, type);
    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error)],
        ...EPHEMERAL,
      });
      return true;
    }
    await interaction.reply({
      ...buildCreditManagerMessage(guildId),
      content: [
        `Added \`${result.added}\` ${type} credit to <@${userId}>.`,
        formatCredits(result.credits),
      ].join('\n'),
    });
    return true;
  }

  if (interaction.isModalSubmit() && id.startsWith('credithub:modal:remove:')) {
    const rest = id.slice('credithub:modal:remove:'.length);
    const lastColon = rest.lastIndexOf(':');
    const userId = rest.slice(0, lastColon);
    const type = rest.slice(lastColon + 1);
    const amountRaw = interaction.fields.getTextInputValue('amount');
    const result = removeCredit(guildId, userId, amountRaw, type);
    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error)],
        ...EPHEMERAL,
      });
      return true;
    }
    await interaction.reply({
      ...buildCreditManagerMessage(guildId),
      content: [
        `Removed \`${result.removed}\` ${type} credit from <@${userId}>.`,
        formatCredits(result.credits),
      ].join('\n'),
    });
    return true;
  }

  return true;
}

module.exports = {
  buildCreditManagerMessage,
  handleCreditManagerInteraction,
};

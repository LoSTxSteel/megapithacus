const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const {
  addCredit,
  removeCredit,
  wipeSeasonal,
  wipePermanent,
} = require('../services/credits');
const { canManageCredits } = require('../services/guildPermissions');
const { errorEmbed, guildEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');

function creditTypeOption(opt) {
  return opt
    .setName('type')
    .setDescription('Credit type')
    .setRequired(true)
    .addChoices(
      { name: 'Seasonal', value: 'seasonal' },
      { name: 'Permanent', value: 'permanent' }
    );
}

function formatCredits(credits) {
  return `Seasonal: \`${credits.seasonal}\` · Permanent: \`${credits.permanent}\``;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('creditmanager')
    .setDescription('Add, remove, or wipe seasonal and permanent credits')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('wipe-seasonal')
        .setDescription("Wipe everyone's seasonal credit")
    )
    .addSubcommand((sub) =>
      sub
        .setName('wipe-permanent')
        .setDescription("Wipe everyone's permanent credit")
    )
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add credit to a user')
        .addUserOption((opt) =>
          opt.setName('user').setDescription('User to credit').setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('amount')
            .setDescription('Amount to add')
            .setRequired(true)
            .setMinValue(1)
        )
        .addStringOption(creditTypeOption)
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove credit from a user (not below 0)')
        .addUserOption((opt) =>
          opt.setName('user').setDescription('User to debit').setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('amount')
            .setDescription('Amount to remove')
            .setRequired(true)
            .setMinValue(1)
        )
        .addStringOption(creditTypeOption)
    ),

  async execute(interaction) {
    if (!canManageCredits(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'You do not have permission to manage credits.\n' +
              'Ask the server owner to grant your role with `/permissions set` → **Credit manager**.'
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    const guildId = interaction.guildId;
    const guild = getGuild(guildId);
    const sub = interaction.options.getSubcommand();

    if (sub === 'wipe-seasonal') {
      const result = wipeSeasonal(guildId);
      await interaction.reply({
        embeds: [
          guildEmbed(guild, 'Seasonal credits wiped', { context: 'Credits' }).setDescription(
            `Cleared seasonal credit for **${result.wiped}** user(s).`
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    if (sub === 'wipe-permanent') {
      const result = wipePermanent(guildId);
      await interaction.reply({
        embeds: [
          guildEmbed(guild, 'Permanent credits wiped', { context: 'Credits' }).setDescription(
            `Cleared permanent credit for **${result.wiped}** user(s).`
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    const user = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);
    const type = interaction.options.getString('type', true);

    if (sub === 'add') {
      const result = addCredit(guildId, user.id, amount, type);
      if (!result.ok) {
        await interaction.reply({
          embeds: [errorEmbed(result.error)],
          ephemeral: true,
        });
        return;
      }
      await interaction.reply({
        embeds: [
          guildEmbed(guild, 'Credit added', { context: 'Credits' }).setDescription(
            [
              `Added \`${result.added}\` ${type} credit to <@${user.id}>.`,
              formatCredits(result.credits),
            ].join('\n')
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    if (sub === 'remove') {
      const result = removeCredit(guildId, user.id, amount, type);
      if (!result.ok) {
        await interaction.reply({
          embeds: [errorEmbed(result.error)],
          ephemeral: true,
        });
        return;
      }
      await interaction.reply({
        embeds: [
          guildEmbed(guild, 'Credit removed', { context: 'Credits' }).setDescription(
            [
              `Removed \`${result.removed}\` ${type} credit from <@${user.id}>.`,
              formatCredits(result.credits),
            ].join('\n')
          ),
        ],
        ephemeral: true,
      });
      return;
    }
  },
};

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const { getUserCredits } = require('../services/credits');
const { canManageCredits } = require('../services/guildPermissions');
const { errorEmbed, guildEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('creditview')
    .setDescription("View a user's seasonal and permanent credit")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('User to view')
        .setRequired(true)
    ),

  async execute(interaction) {
    if (!canManageCredits(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'You do not have permission to view credits.\n' +
              'Ask the server owner to grant your role with `/permissions set` → **Credit manager**.'
          ),
        ],
        ...EPHEMERAL,
      });
      return;
    }

    const user = interaction.options.getUser('user', true);
    const credits = getUserCredits(interaction.guildId, user.id);
    const guild = getGuild(interaction.guildId);

    await interaction.reply({
      embeds: [
        guildEmbed(guild, 'Credit balance', { context: 'Credits' }).setDescription(
          [
            `User: <@${user.id}>`,
            `Seasonal: \`${credits.seasonal}\``,
            `Permanent: \`${credits.permanent}\``,
          ].join('\n')
        ),
      ],
      ...EPHEMERAL,
    });
  },
};

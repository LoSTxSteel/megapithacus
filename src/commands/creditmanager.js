const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { buildCreditManagerMessage } = require('../management/creditHub');
const { canManageCredits } = require('../services/guildPermissions');
const { errorEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('creditmanager')
    .setDescription('Manage seasonal and permanent credits')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

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

    await interaction.reply(buildCreditManagerMessage(interaction.guildId));
  },
};

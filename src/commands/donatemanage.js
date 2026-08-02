const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { buildDonateManagePanel } = require('../management/donateHub');
const { canManageDonations } = require('../services/guildPermissions');
const { errorEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('donatemanage')
    .setDescription('Manage donation methods and links')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!canManageDonations(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'You do not have permission to manage donations.\n' +
              'Ask the server owner to grant your role with `/permissions set` → **Donations**.'
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    await interaction.reply(buildDonateManagePanel(interaction.guildId));
  },
};

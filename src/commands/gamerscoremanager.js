const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const {
  buildGamerscoreManagerMessage,
} = require('../management/gamerscoreHub');
const { canManageGamerscore } = require('../services/guildPermissions');
const { errorEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('gamerscoremanager')
    .setDescription('Configure Xbox gamerscore join checks and punishments')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!canManageGamerscore(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'You do not have permission to manage gamerscore detection.\n' +
              'Ask the server owner to grant your role with `/permissions set` → **Gamerscore manager**.'
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    await interaction.reply(buildGamerscoreManagerMessage(interaction.guildId));
  },
};

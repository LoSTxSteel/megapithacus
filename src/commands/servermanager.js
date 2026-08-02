const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { buildServerManagerMessage } = require('../management/serverManagerHub');
const { canManageServerPower } = require('../services/guildPermissions');
const { errorEmbed } = require('../utils/embeds');
const { ADMIN_ROLE_NAME } = require('../services/botSetup');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('servermanager')
    .setDescription('Manage Nitrado servers — power, password, and name')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!canManageServerPower(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            `You do not have permission to manage servers.\n` +
              `Need **Manage Server**, the **${ADMIN_ROLE_NAME}** role, or a role granted under **Server power**.`
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply(await buildServerManagerMessage(interaction.guildId));
  },
};

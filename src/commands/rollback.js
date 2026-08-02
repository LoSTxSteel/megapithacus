const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const { openRollbackHub } = require('../management/saveHub');
const { canManageServerPower } = require('../services/guildPermissions');
const { errorEmbed } = require('../utils/embeds');
const { ADMIN_ROLE_NAME } = require('../services/botSetup');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rollback')
    .setDescription('Rollback ASE save from Nitrado backups / SavedArks')
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
        ...EPHEMERAL,
      });
      return;
    }

    await interaction.deferReply({ ...EPHEMERAL });
    await interaction.editReply(await openRollbackHub(interaction));
  },
};

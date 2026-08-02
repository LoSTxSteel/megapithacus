const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const { buildAdminPayMessage } = require('../management/adminPayHub');
const { canManageAdminPay } = require('../services/guildPermissions');
const { errorEmbed } = require('../utils/embeds');
const { ADMIN_ROLE_NAME } = require('../services/botSetup');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('adminpay')
    .setDescription('Configure admin pay rates and review payout requests')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!canManageAdminPay(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            `You do not have permission to manage Admin Pay.\n` +
              `Need **Manage Server**, the **${ADMIN_ROLE_NAME}** role, or a role granted under **Admin Pay** (\`/permissions\`).`
          ),
        ],
        ...EPHEMERAL,
      });
      return;
    }

    await interaction.reply(buildAdminPayMessage(interaction.guildId));
  },
};

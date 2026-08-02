const { SlashCommandBuilder } = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const { buildPayMessage } = require('../management/payHub');
const { canUsePay } = require('../services/guildPermissions');
const { errorEmbed } = require('../utils/embeds');
const { ADMIN_ROLE_NAME } = require('../services/botSetup');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pay')
    .setDescription('View your admin pay balance, log work, and request payouts'),

  async execute(interaction) {
    if (!canUsePay(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            `You do not have permission to use Admin Pay.\n` +
              `Need a configured **/pay** role, **Manage Server**, or the **${ADMIN_ROLE_NAME}** role.`
          ),
        ],
        ...EPHEMERAL,
      });
      return;
    }

    await interaction.reply(
      buildPayMessage(interaction.guildId, interaction.user.id)
    );
  },
};

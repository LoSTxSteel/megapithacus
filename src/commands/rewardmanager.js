const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { buildRewardManagerMessage } = require('../management/rewardHub');
const { canManageRewards } = require('../services/guildPermissions');
const { errorEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rewardmanager')
    .setDescription('Configure server boost credit rewards')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!canManageRewards(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'You do not have permission to manage boost rewards.\n' +
              'Ask the server owner to grant your role with `/permissions set` → **Reward manager**.'
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    await interaction.reply(buildRewardManagerMessage(interaction.guildId));
  },
};

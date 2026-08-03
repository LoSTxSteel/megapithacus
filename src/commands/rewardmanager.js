const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const { buildRewardManagerMessage } = require('../management/rewardHub');
const { canManageRewards } = require('../services/guildPermissions');
const { errorEmbed } = require('../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rewardmanager')
    .setDescription('Configure boost and invite credit rewards')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!canManageRewards(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'You do not have permission to manage rewards.\n' +
              'Ask the server owner to grant your role with `/permissions` → **Reward manager**.'
          ),
        ],
        ...EPHEMERAL,
      });
      return;
    }

    await interaction.reply(buildRewardManagerMessage(interaction.guildId));
  },
};

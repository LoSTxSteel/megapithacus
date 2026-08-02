const { SlashCommandBuilder } = require('discord.js');
const { getUserCredits } = require('../services/credits');
const { guildEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('credit')
    .setDescription('View your seasonal and permanent credit'),

  async execute(interaction) {
    const credits = getUserCredits(interaction.guildId, interaction.user.id);
    const guild = interaction.guildId ? getGuild(interaction.guildId) : null;

    await interaction.reply({
      embeds: [
        guildEmbed(guild, 'Your credits', { context: 'Credits' }).setDescription(
          [
            `Seasonal: **${credits.seasonal}**`,
            `Permanent: **${credits.permanent}**`,
          ].join('\n')
        ),
      ],
      ephemeral: true,
    });
  },
};

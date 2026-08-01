const { SlashCommandBuilder } = require('discord.js');
const { buildSubscribeEmbed } = require('../services/subscribeInfo');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('subscribe')
    .setDescription('Subscribe info (currently under maintenance)'),

  async execute(interaction) {
    await interaction.reply({
      embeds: [buildSubscribeEmbed(interaction.guildId)],
      ephemeral: true,
    });
  },
};

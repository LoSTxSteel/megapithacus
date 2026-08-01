const { SlashCommandBuilder } = require('discord.js');
const { buildSubscribeEmbed } = require('../services/subscribeInfo');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('subscribe')
    .setDescription('How to join / subscribe to the ASE cluster'),

  async execute(interaction) {
    await interaction.reply({
      embeds: [buildSubscribeEmbed(interaction.guildId)],
      ephemeral: true,
    });
  },
};

const { SlashCommandBuilder } = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const { buildSubscribeEmbed } = require('../services/subscribeInfo');
const { addSubscriber } = require('../services/announceSubscribers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('subscribe')
    .setDescription('Subscribe to Megapithacus announcement DMs'),

  async execute(interaction) {
    addSubscriber(interaction.user.id, interaction.guildId);
    await interaction.reply({
      embeds: [buildSubscribeEmbed(interaction.guildId)],
      ...EPHEMERAL,
    });
  },
};

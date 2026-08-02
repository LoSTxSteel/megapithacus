const { SlashCommandBuilder } = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const {
  addSubscriber,
  isSubscriber,
} = require('../services/announceSubscribers');
const { successEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('notify')
    .setDescription('Opt in to Megapithacus announcement DMs (discounts, updates)'),

  async execute(interaction) {
    const already = isSubscriber(interaction.user.id);
    addSubscriber(interaction.user.id, interaction.guildId);

    await interaction.reply({
      embeds: [
        successEmbed(
          already ? 'Notifications already on' : 'Notifications enabled',
          [
            already
              ? 'You were already opted in to announcement DMs.'
              : 'You will receive discounts, updates, and other adverts in your DMs.',
            '',
            'Use `/unnotify` anytime to stop.',
            'You must allow DMs from server members for this to work.',
          ].join('\n'),
          interaction.guildId ? getGuild(interaction.guildId) : null
        ),
      ],
      ...EPHEMERAL,
    });
  },
};

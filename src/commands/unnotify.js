const { SlashCommandBuilder } = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const {
  removeSubscriber,
  isSubscriber,
} = require('../services/announceSubscribers');
const { successEmbed, guildEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unnotify')
    .setDescription('Opt out of Megapithacus announcement DMs'),

  async execute(interaction) {
    const was = isSubscriber(interaction.user.id);
    removeSubscriber(interaction.user.id);

    const guild = interaction.guildId ? getGuild(interaction.guildId) : null;
    await interaction.reply({
      embeds: [
        was
          ? successEmbed(
              'Notifications disabled',
              'You will no longer receive announcement DMs.\nUse `/notify` to opt back in.',
              guild
            )
          : guildEmbed(guild, 'Notifications already off', {
              context: 'Help',
            }).setDescription(
              'You were not on the announcement list.\nUse `/notify` if you want DM adverts.'
            ),
      ],
      ...EPHEMERAL,
    });
  },
};

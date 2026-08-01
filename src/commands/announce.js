const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { broadcastAnnounce, ANNOUNCE_TYPES } = require('../services/announce');
const { subscriberCount } = require('../services/announceSubscribers');
const { errorEmbed, successEmbed, guildEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('announce')
    .setDescription('DM subscribers with a discount, update, or other announcement')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt
        .setName('type')
        .setDescription('Announcement type')
        .setRequired(true)
        .addChoices(
          { name: 'Discount', value: 'discount' },
          { name: 'Update', value: 'update' },
          { name: 'Other', value: 'other' }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName('message')
        .setDescription('Message body to send in DMs')
        .setRequired(true)
        .setMaxLength(2000)
    )
    .addStringOption((opt) =>
      opt
        .setName('title')
        .setDescription('Optional custom title')
        .setRequired(false)
        .setMaxLength(100)
    ),

  async execute(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        embeds: [errorEmbed('You need **Manage Server** to use `/announce`.')],
        ephemeral: true,
      });
      return;
    }

    const type = interaction.options.getString('type', true);
    const message = interaction.options.getString('message', true);
    const title = interaction.options.getString('title');
    const count = subscriberCount();

    if (!count) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'No one has opted in yet. Players must use `/notify` (or DM the bot `notify`) first.'
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    await interaction.editReply({
      embeds: [
        guildEmbed(getGuild(interaction.guildId), 'Sending announcement…', {
          context: 'Announce',
        }).setDescription(
          `DMing **${count}** subscriber(s) (**${ANNOUNCE_TYPES[type]?.label || type}**).`
        ),
      ],
    });

    const result = await broadcastAnnounce(interaction.client, interaction.guildId, {
      type,
      title,
      message,
    });

    await interaction.editReply({
      embeds: [
        successEmbed(
          'Announcement sent',
          [
            `Type: **${ANNOUNCE_TYPES[type]?.label || type}**`,
            `Delivered: **${result.sent}** / ${result.total}`,
            result.failed ? `Failed (DMs closed): **${result.failed}**` : null,
            '',
            'Announcement DMs are kept (not auto-deleted).',
          ]
            .filter(Boolean)
            .join('\n')
        ),
        result.embed,
      ],
    });
  },
};

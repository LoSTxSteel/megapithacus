const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');
const {
  setBoostEnabled,
  setBoostChannel,
} = require('../services/credits');
const { canManageRewards } = require('../services/guildPermissions');
const { errorEmbed, guildEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rewardmanager')
    .setDescription('Configure server boost credit rewards')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub.setName('enable').setDescription('Enable boost rewards (+3 seasonal credit)')
    )
    .addSubcommand((sub) =>
      sub.setName('disable').setDescription('Disable boost rewards')
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-channel')
        .setDescription('Set the channel for boost thank-you messages')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Channel to post boost thank-yous')
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement
            )
            .setRequired(true)
        )
    ),

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

    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();
    const guild = getGuild(guildId);

    if (sub === 'enable') {
      const rewards = setBoostEnabled(guildId, true);
      const channelLine = rewards.boostChannelId
        ? `Thank-you channel: <#${rewards.boostChannelId}>`
        : '_No thank-you channel set yet — use `/rewardmanager set-channel`._';
      await interaction.reply({
        embeds: [
          guildEmbed(guild, 'Boost rewards enabled', { context: 'Rewards' }).setDescription(
            [
              'Server boosts now grant **+3 seasonal credit**.',
              channelLine,
            ].join('\n')
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    if (sub === 'disable') {
      setBoostEnabled(guildId, false);
      await interaction.reply({
        embeds: [
          guildEmbed(guild, 'Boost rewards disabled', { context: 'Rewards' }).setDescription(
            'Boost thank-yous and credit grants are turned off.'
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    if (sub === 'set-channel') {
      const channel = interaction.options.getChannel('channel', true);
      const rewards = setBoostChannel(guildId, channel.id);
      const status = rewards.boostEnabled
        ? 'Boost rewards are **enabled**.'
        : 'Boost rewards are still **disabled** — run `/rewardmanager enable` when ready.';
      await interaction.reply({
        embeds: [
          guildEmbed(guild, 'Boost channel set', { context: 'Rewards' }).setDescription(
            [`Thank-you channel: <#${channel.id}>`, status].join('\n')
          ),
        ],
        ephemeral: true,
      });
    }
  },
};

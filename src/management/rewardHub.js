const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
} = require('discord.js');
const {
  getRewards,
  setBoostEnabled,
  setBoostChannel,
  setBoostAmount,
  setBoostCreditType,
} = require('../services/credits');
const { canManageRewards } = require('../services/guildPermissions');
const { guildEmbed, errorEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');

function denyRewards(interaction) {
  const payload = {
    embeds: [
      errorEmbed(
        'You do not have permission to manage boost rewards.\n' +
          'Ask the server owner to grant your role with `/permissions set` → **Reward manager**.'
      ),
    ],
    ephemeral: true,
  };
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(payload);
  }
  return interaction.reply(payload);
}

function backRewards() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('rewardhub:back')
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );
}

function creditTypeLabel(type) {
  return type === 'permanent' ? 'permanent' : 'seasonal';
}

function rewardsSummary(guildId) {
  const rewards = getRewards(guildId);
  const amount = Math.max(0, Number(rewards.boostSeasonalAmount) || 3);
  const type = creditTypeLabel(rewards.boostCreditType);
  const channelLine = rewards.boostChannelId
    ? `Thank-you channel: <#${rewards.boostChannelId}>`
    : 'Thank-you channel: _not set_';
  return [
    `Status: **${rewards.boostEnabled ? 'enabled' : 'disabled'}**`,
    channelLine,
    `Boost credit: \`${amount}\` ${type}`,
  ].join('\n');
}

function buildRewardManagerMessage(guildId, { content = null } = {}) {
  const guild = getGuild(guildId);
  return {
    embeds: [
      guildEmbed(guild, 'Reward Manager', { context: 'Rewards' }).setDescription(
        [
          'Configure server boost thank-yous and credit grants.',
          '',
          rewardsSummary(guildId),
          '',
          'Pick an action below.',
        ].join('\n')
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('rewardhub:action')
          .setPlaceholder('Reward manager actions')
          .addOptions(
            {
              label: 'Enable boost rewards',
              description: 'Turn on thank-yous and credit grants',
              value: 'enable',
            },
            {
              label: 'Disable boost rewards',
              description: 'Turn off thank-yous and credit grants',
              value: 'disable',
            },
            {
              label: 'Set boost channel',
              description: 'Channel for boost thank-you messages',
              value: 'set-channel',
            },
            {
              label: 'Set boost credit amount',
              description: 'How much credit a boost grants',
              value: 'set-amount',
            },
            {
              label: 'Set boost credit type',
              description: 'Seasonal or permanent credit',
              value: 'set-type',
            }
          )
      ),
    ],
    content,
    ephemeral: true,
  };
}

function amountModal(guildId) {
  const rewards = getRewards(guildId);
  const current = String(Math.max(0, Number(rewards.boostSeasonalAmount) || 3));
  return new ModalBuilder()
    .setCustomId('rewardhub:modal:amount')
    .setTitle('Boost credit amount')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('amount')
          .setLabel('Credit amount on boost')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(10)
          .setValue(current.slice(0, 10))
          .setPlaceholder('e.g. 3')
      )
    );
}

async function handleRewardManagerInteraction(interaction) {
  const id = interaction.customId;
  if (!id?.startsWith('rewardhub:')) return false;

  if (!canManageRewards(interaction)) {
    await denyRewards(interaction);
    return true;
  }

  const guildId = interaction.guildId;
  const guild = getGuild(guildId);

  if (interaction.isButton() && id === 'rewardhub:back') {
    await interaction.update(buildRewardManagerMessage(guildId));
    return true;
  }

  if (interaction.isStringSelectMenu() && id === 'rewardhub:action') {
    const action = interaction.values[0];

    if (action === 'enable') {
      setBoostEnabled(guildId, true);
      await interaction.update(
        buildRewardManagerMessage(guildId, {
          content: 'Boost rewards enabled.',
        })
      );
      return true;
    }

    if (action === 'disable') {
      setBoostEnabled(guildId, false);
      await interaction.update(
        buildRewardManagerMessage(guildId, {
          content: 'Boost rewards disabled.',
        })
      );
      return true;
    }

    if (action === 'set-channel') {
      await interaction.update({
        embeds: [
          guildEmbed(guild, 'Set boost channel', { context: 'Rewards' }).setDescription(
            'Select the channel for boost thank-you messages.'
          ),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId('rewardhub:channel')
              .setPlaceholder('Select thank-you channel')
              .setMinValues(1)
              .setMaxValues(1)
              .setChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement
              )
          ),
          backRewards(),
        ],
        content: null,
      });
      return true;
    }

    if (action === 'set-amount') {
      await interaction.showModal(amountModal(guildId));
      return true;
    }

    if (action === 'set-type') {
      const rewards = getRewards(guildId);
      const current = creditTypeLabel(rewards.boostCreditType);
      await interaction.update({
        embeds: [
          guildEmbed(guild, 'Boost credit type', { context: 'Rewards' }).setDescription(
            [
              `Currently: **${current}**`,
              'Choose whether boosts grant seasonal or permanent credit.',
            ].join('\n')
          ),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('rewardhub:type')
              .setPlaceholder('Seasonal or permanent')
              .addOptions(
                {
                  label: 'Seasonal',
                  description: 'Wiped with seasonal wipe',
                  value: 'seasonal',
                },
                {
                  label: 'Permanent',
                  description: 'Kept until wiped or removed',
                  value: 'permanent',
                }
              )
          ),
          backRewards(),
        ],
        content: null,
      });
      return true;
    }
  }

  if (interaction.isChannelSelectMenu() && id === 'rewardhub:channel') {
    const channelId = interaction.values[0];
    setBoostChannel(guildId, channelId);
    await interaction.update(
      buildRewardManagerMessage(guildId, {
        content: `Thank-you channel set to <#${channelId}>.`,
      })
    );
    return true;
  }

  if (interaction.isStringSelectMenu() && id === 'rewardhub:type') {
    const type = interaction.values[0];
    const result = setBoostCreditType(guildId, type);
    if (!result.ok) {
      await interaction.update(
        buildRewardManagerMessage(guildId, { content: result.error })
      );
      return true;
    }
    await interaction.update(
      buildRewardManagerMessage(guildId, {
        content: `Boost credit type set to **${creditTypeLabel(type)}**.`,
      })
    );
    return true;
  }

  if (interaction.isModalSubmit() && id === 'rewardhub:modal:amount') {
    const amountRaw = interaction.fields.getTextInputValue('amount');
    const result = setBoostAmount(guildId, amountRaw);
    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error)],
        ephemeral: true,
      });
      return true;
    }
    const amount = Math.max(0, Number(result.rewards.boostSeasonalAmount) || 0);
    await interaction.reply({
      ...buildRewardManagerMessage(guildId),
      content: `Boost credit amount set to \`${amount}\`.`,
    });
    return true;
  }

  return true;
}

module.exports = {
  buildRewardManagerMessage,
  handleRewardManagerInteraction,
};

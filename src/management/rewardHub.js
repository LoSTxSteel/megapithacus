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
const { EPHEMERAL } = require('../utils/ephemeral');
const {
  getRewards,
  setBoostEnabled,
  setBoostChannel,
  setBoostAmount,
  setBoostCreditType,
  setInviteEnabled,
  setInviteChannel,
  setInviteAmount,
  setInviteCreditType,
  setInvitesRequiredPerReward,
} = require('../services/credits');
const { canManageRewards } = require('../services/guildPermissions');
const { guildEmbed, errorEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');

function denyRewards(interaction) {
  const payload = {
    embeds: [
      errorEmbed(
        'You do not have permission to manage rewards.\n' +
          'Ask the server owner to grant your role with `/permissions` → **Reward manager**.'
      ),
    ],
    ...EPHEMERAL,
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
  const boostAmount = Math.max(0, Number(rewards.boostSeasonalAmount) || 3);
  const boostType = creditTypeLabel(rewards.boostCreditType);
  const boostChannel = rewards.boostChannelId
    ? `Thank-you channel: <#${rewards.boostChannelId}>`
    : 'Thank-you channel: _not set_';

  const inviteAmount = Math.max(0, Number(rewards.inviteCreditAmount) || 1);
  const inviteType = creditTypeLabel(rewards.inviteCreditType);
  const inviteEvery = Math.max(1, Number(rewards.invitesRequiredPerReward) || 1);
  const inviteChannel = rewards.inviteChannelId
    ? `Thank-you channel: <#${rewards.inviteChannelId}>`
    : 'Thank-you channel: _not set_';

  return [
    '**Boost rewards**',
    `Status: **${rewards.boostEnabled ? 'enabled' : 'disabled'}**`,
    boostChannel,
    `Boost credit: \`${boostAmount}\` ${boostType}`,
    '',
    '**Invite rewards**',
    `Status: **${rewards.inviteEnabled ? 'enabled' : 'disabled'}**`,
    inviteChannel,
    `Invite credit: \`${inviteAmount}\` ${inviteType} every \`${inviteEvery}\` invite(s)`,
  ].join('\n');
}

function buildRewardManagerMessage(guildId, { content = null } = {}) {
  const guild = getGuild(guildId);
  return {
    embeds: [
      guildEmbed(guild, 'Reward Manager', { context: 'Rewards' }).setDescription(
        [
          'Configure boost and invite thank-yous and credit grants.',
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
              description: 'Turn on boost thank-yous and credit',
              value: 'boost-enable',
            },
            {
              label: 'Disable boost rewards',
              description: 'Turn off boost thank-yous and credit',
              value: 'boost-disable',
            },
            {
              label: 'Set boost channel',
              description: 'Channel for boost thank-you messages',
              value: 'boost-channel',
            },
            {
              label: 'Set boost credit amount',
              description: 'How much credit a boost grants',
              value: 'boost-amount',
            },
            {
              label: 'Set boost credit type',
              description: 'Seasonal or permanent credit',
              value: 'boost-type',
            },
            {
              label: 'Enable invite rewards',
              description: 'Turn on invite thank-yous and credit',
              value: 'invite-enable',
            },
            {
              label: 'Disable invite rewards',
              description: 'Turn off invite thank-yous and credit',
              value: 'invite-disable',
            },
            {
              label: 'Set invite channel',
              description: 'Channel for invite thank-you messages',
              value: 'invite-channel',
            },
            {
              label: 'Set invite credit amount',
              description: 'Credit granted to the inviter per reward',
              value: 'invite-amount',
            },
            {
              label: 'Set invite credit type',
              description: 'Seasonal or permanent credit',
              value: 'invite-type',
            },
            {
              label: 'Set invites per reward',
              description: 'Grant credit every N successful invites',
              value: 'invite-every',
            }
          )
      ),
    ],
    content,
    ...EPHEMERAL,
  };
}

function amountModal(customId, title, current, placeholder) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('amount')
          .setLabel('Amount')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(10)
          .setValue(String(current).slice(0, 10))
          .setPlaceholder(placeholder)
      )
    );
}

function typePickerPanel(guildId, customId, title, description, current) {
  return {
    embeds: [
      guildEmbed(getGuild(guildId), title, { context: 'Rewards' }).setDescription(
        [`Currently: **${creditTypeLabel(current)}**`, description].join('\n')
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(customId)
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
  };
}

function channelPickerPanel(guildId, customId, title, description) {
  return {
    embeds: [
      guildEmbed(getGuild(guildId), title, { context: 'Rewards' }).setDescription(
        description
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(customId)
          .setPlaceholder('Select thank-you channel')
          .setMinValues(1)
          .setMaxValues(1)
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      ),
      backRewards(),
    ],
    content: null,
  };
}

async function handleRewardManagerInteraction(interaction) {
  const id = interaction.customId;
  if (!id?.startsWith('rewardhub:')) return false;

  if (!canManageRewards(interaction)) {
    await denyRewards(interaction);
    return true;
  }

  const guildId = interaction.guildId;

  if (interaction.isButton() && id === 'rewardhub:back') {
    await interaction.update(buildRewardManagerMessage(guildId));
    return true;
  }

  if (interaction.isStringSelectMenu() && id === 'rewardhub:action') {
    const action = interaction.values[0];

    if (action === 'boost-enable') {
      setBoostEnabled(guildId, true);
      await interaction.update(
        buildRewardManagerMessage(guildId, { content: 'Boost rewards enabled.' })
      );
      return true;
    }
    if (action === 'boost-disable') {
      setBoostEnabled(guildId, false);
      await interaction.update(
        buildRewardManagerMessage(guildId, { content: 'Boost rewards disabled.' })
      );
      return true;
    }
    if (action === 'boost-channel') {
      await interaction.update(
        channelPickerPanel(
          guildId,
          'rewardhub:channel:boost',
          'Set boost channel',
          'Select the channel for boost thank-you messages.'
        )
      );
      return true;
    }
    if (action === 'boost-amount') {
      const rewards = getRewards(guildId);
      const current = String(Math.max(0, Number(rewards.boostSeasonalAmount) || 3));
      await interaction.showModal(
        amountModal(
          'rewardhub:modal:boost-amount',
          'Boost credit amount',
          current,
          'e.g. 3'
        )
      );
      return true;
    }
    if (action === 'boost-type') {
      const rewards = getRewards(guildId);
      await interaction.update(
        typePickerPanel(
          guildId,
          'rewardhub:type:boost',
          'Boost credit type',
          'Choose whether boosts grant seasonal or permanent credit.',
          rewards.boostCreditType
        )
      );
      return true;
    }

    if (action === 'invite-enable') {
      setInviteEnabled(guildId, true);
      await interaction.update(
        buildRewardManagerMessage(guildId, { content: 'Invite rewards enabled.' })
      );
      return true;
    }
    if (action === 'invite-disable') {
      setInviteEnabled(guildId, false);
      await interaction.update(
        buildRewardManagerMessage(guildId, { content: 'Invite rewards disabled.' })
      );
      return true;
    }
    if (action === 'invite-channel') {
      await interaction.update(
        channelPickerPanel(
          guildId,
          'rewardhub:channel:invite',
          'Set invite channel',
          'Select the channel for invite thank-you messages.'
        )
      );
      return true;
    }
    if (action === 'invite-amount') {
      const rewards = getRewards(guildId);
      const current = String(Math.max(0, Number(rewards.inviteCreditAmount) || 1));
      await interaction.showModal(
        amountModal(
          'rewardhub:modal:invite-amount',
          'Invite credit amount',
          current,
          'e.g. 1'
        )
      );
      return true;
    }
    if (action === 'invite-type') {
      const rewards = getRewards(guildId);
      await interaction.update(
        typePickerPanel(
          guildId,
          'rewardhub:type:invite',
          'Invite credit type',
          'Choose whether invite rewards grant seasonal or permanent credit.',
          rewards.inviteCreditType
        )
      );
      return true;
    }
    if (action === 'invite-every') {
      const rewards = getRewards(guildId);
      const current = String(
        Math.max(1, Number(rewards.invitesRequiredPerReward) || 1)
      );
      await interaction.showModal(
        amountModal(
          'rewardhub:modal:invite-every',
          'Invites per reward',
          current,
          'e.g. 5'
        )
      );
      return true;
    }
  }

  if (interaction.isChannelSelectMenu() && id === 'rewardhub:channel:boost') {
    const channelId = interaction.values[0];
    setBoostChannel(guildId, channelId);
    await interaction.update(
      buildRewardManagerMessage(guildId, {
        content: `Boost thank-you channel set to <#${channelId}>.`,
      })
    );
    return true;
  }

  if (interaction.isChannelSelectMenu() && id === 'rewardhub:channel:invite') {
    const channelId = interaction.values[0];
    setInviteChannel(guildId, channelId);
    await interaction.update(
      buildRewardManagerMessage(guildId, {
        content: `Invite thank-you channel set to <#${channelId}>.`,
      })
    );
    return true;
  }

  // Legacy custom id from older boost-only hub
  if (interaction.isChannelSelectMenu() && id === 'rewardhub:channel') {
    const channelId = interaction.values[0];
    setBoostChannel(guildId, channelId);
    await interaction.update(
      buildRewardManagerMessage(guildId, {
        content: `Boost thank-you channel set to <#${channelId}>.`,
      })
    );
    return true;
  }

  if (interaction.isStringSelectMenu() && id === 'rewardhub:type:boost') {
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

  if (interaction.isStringSelectMenu() && id === 'rewardhub:type:invite') {
    const type = interaction.values[0];
    const result = setInviteCreditType(guildId, type);
    if (!result.ok) {
      await interaction.update(
        buildRewardManagerMessage(guildId, { content: result.error })
      );
      return true;
    }
    await interaction.update(
      buildRewardManagerMessage(guildId, {
        content: `Invite credit type set to **${creditTypeLabel(type)}**.`,
      })
    );
    return true;
  }

  // Legacy
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

  if (interaction.isModalSubmit() && id === 'rewardhub:modal:boost-amount') {
    const amountRaw = interaction.fields.getTextInputValue('amount');
    const result = setBoostAmount(guildId, amountRaw);
    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error)],
        ...EPHEMERAL,
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

  // Legacy modal id
  if (interaction.isModalSubmit() && id === 'rewardhub:modal:amount') {
    const amountRaw = interaction.fields.getTextInputValue('amount');
    const result = setBoostAmount(guildId, amountRaw);
    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error)],
        ...EPHEMERAL,
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

  if (interaction.isModalSubmit() && id === 'rewardhub:modal:invite-amount') {
    const amountRaw = interaction.fields.getTextInputValue('amount');
    const result = setInviteAmount(guildId, amountRaw);
    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error)],
        ...EPHEMERAL,
      });
      return true;
    }
    const amount = Math.max(0, Number(result.rewards.inviteCreditAmount) || 0);
    await interaction.reply({
      ...buildRewardManagerMessage(guildId),
      content: `Invite credit amount set to \`${amount}\`.`,
    });
    return true;
  }

  if (interaction.isModalSubmit() && id === 'rewardhub:modal:invite-every') {
    const amountRaw = interaction.fields.getTextInputValue('amount');
    const result = setInvitesRequiredPerReward(guildId, amountRaw);
    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error)],
        ...EPHEMERAL,
      });
      return true;
    }
    const every = Math.max(
      1,
      Number(result.rewards.invitesRequiredPerReward) || 1
    );
    await interaction.reply({
      ...buildRewardManagerMessage(guildId),
      content: `Invite rewards grant credit every \`${every}\` successful invite(s).`,
    });
    return true;
  }

  return true;
}

module.exports = {
  buildRewardManagerMessage,
  handleRewardManagerInteraction,
};

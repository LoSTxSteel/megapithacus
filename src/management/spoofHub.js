const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const { getGuild, updateGuild } = require('../services/storage');
const {
  isFeatureEnabled,
  isFeatureConfigured,
  setupFeature,
} = require('../services/featureSetup');
const { canManageSpoof } = require('../services/guildPermissions');
const { postSetupReadyEmbed } = require('../services/spoofDetection');
const { guildEmbed, errorEmbed } = require('../utils/embeds');

function denySpoof(interaction) {
  const payload = {
    embeds: [
      errorEmbed(
        'You do not have permission to manage spoof detection.\n' +
          'Ask the server owner to grant your role with `/permissions` → **Spoof manager**.'
      ),
    ],
    ...EPHEMERAL,
  };
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(payload);
  }
  return interaction.reply(payload);
}

function settingsSummary(guildId) {
  const guild = getGuild(guildId);
  const enabled = isFeatureEnabled(guild, 'spoofDetection');
  const configured = isFeatureConfigured(guild, 'spoofDetection');
  const channelId = guild.featureSetup?.spoofDetection?.channelId;
  return [
    `Feature: **${enabled ? 'enabled' : 'disabled'}**${
      configured ? '' : ' _(needs setup)_'
    }`,
    `Log channel: ${channelId ? `<#${channelId}>` : '_not created_'}`,
  ].join('\n');
}

function buildSpoofManagerMessage(guildId, { content = null } = {}) {
  const guild = getGuild(guildId);
  return {
    embeds: [
      guildEmbed(guild, 'Spoof Manager', {
        context: 'Spoof detection',
      }).setDescription(
        [
          'On map join, compare the **Nitrado / in-game displayed name** to the **official Xbox Live gamertag** (OpenXBL).',
          'Mismatches are flagged in `#spoof-detection`. Matches and API failures are quiet (fail-open — no kick/ban).',
          '',
          settingsSummary(guildId),
          '',
          '**Setup**',
          '1. **Enable feature** here (creates `#spoof-detection` if needed), or finish setup in `/management` → Feature Management.',
          '2. Ensure `OPENXBL_API_KEY` is set on the bot host.',
          '',
          'Pick an action below.',
        ].join('\n')
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('spoofhub:action')
          .setPlaceholder('Spoof manager actions')
          .addOptions(
            {
              label: 'Enable feature',
              description: 'Turn on join checks (setup channel if needed)',
              value: 'enable',
            },
            {
              label: 'Disable feature',
              description: 'Stop spoof checks (keeps the channel)',
              value: 'disable',
            }
          )
      ),
    ],
    content,
    ...EPHEMERAL,
  };
}

async function handleSpoofManagerInteraction(interaction) {
  const id = interaction.customId;
  if (!id?.startsWith('spoofhub:')) return false;

  if (!canManageSpoof(interaction)) {
    await denySpoof(interaction);
    return true;
  }

  const guildId = interaction.guildId;

  if (interaction.isStringSelectMenu() && id === 'spoofhub:action') {
    const action = interaction.values[0];

    if (action === 'enable') {
      await interaction.deferUpdate();
      try {
        const wasConfigured = isFeatureConfigured(
          getGuild(guildId),
          'spoofDetection'
        );
        if (!wasConfigured) {
          await setupFeature(interaction.guild, 'spoofDetection');
          await postSetupReadyEmbed(interaction.guild, guildId).catch((err) =>
            console.warn('Spoof setup embed failed:', err.message)
          );
        }
        updateGuild(guildId, { features: { spoofDetection: true } });
        await interaction.editReply(
          buildSpoofManagerMessage(guildId, {
            content: 'Spoof detection enabled.',
          })
        );
      } catch (error) {
        await interaction.editReply(
          buildSpoofManagerMessage(guildId, {
            content: `Enable failed: ${error.message}`,
          })
        );
      }
      return true;
    }

    if (action === 'disable') {
      updateGuild(guildId, { features: { spoofDetection: false } });
      await interaction.update(
        buildSpoofManagerMessage(guildId, {
          content: 'Spoof detection disabled.',
        })
      );
      return true;
    }
  }

  return false;
}

module.exports = {
  buildSpoofManagerMessage,
  handleSpoofManagerInteraction,
};

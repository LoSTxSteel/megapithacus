const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { getGuild, updateGuild } = require('../services/storage');
const {
  isFeatureEnabled,
  isFeatureConfigured,
  setupFeature,
} = require('../services/featureSetup');
const { canManageGamerscore } = require('../services/guildPermissions');
const { hasApiKey } = require('../services/gamerscore');
const {
  settingsFor,
  punishmentSummary,
  postSetupReadyEmbed,
} = require('../services/gamerscoreDetection');
const { guildEmbed, errorEmbed } = require('../utils/embeds');

function denyGamerscore(interaction) {
  const payload = {
    embeds: [
      errorEmbed(
        'You do not have permission to manage gamerscore detection.\n' +
          'Ask the server owner to grant your role with `/permissions set` → **Gamerscore manager**.'
      ),
    ],
    ephemeral: true,
  };
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(payload);
  }
  return interaction.reply(payload);
}

function backGamerscore() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('gscorehub:back')
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );
}

function settingsSummary(guildId) {
  const guild = getGuild(guildId);
  const settings = settingsFor(guild);
  const enabled = isFeatureEnabled(guild, 'gamerscoreDetection');
  const configured = isFeatureConfigured(guild, 'gamerscoreDetection');
  const channelId = guild.featureSetup?.gamerscoreDetection?.channelId;
  return [
    `Feature: **${enabled ? 'enabled' : 'disabled'}**${
      configured ? '' : ' _(needs setup)_'
    }`,
    `Log channel: ${channelId ? `<#${channelId}>` : '_not created_'}`,
    `Minimum gamerscore: \`${settings.minScore}\``,
    `Punishment: **${punishmentSummary(settings)}**`,
    `Log passes: **${settings.logPasses ? 'yes' : 'no'}**`,
    `OpenXBL API key: **${hasApiKey() ? 'configured' : 'missing'}**`,
  ].join('\n');
}

function setupInstructions() {
  return [
    '**Setup**',
    '1. Enable & set up **Gamerscore Detection** here or in `/management` → Feature Management (creates `#gamerscore-detection`).',
    '2. Set `OPENXBL_API_KEY` on the bot host (free key: https://xbl.io). Alias: `XBOX_API_KEY`.',
    '3. Configure minimum score and punishment below.',
    '',
    'Without an API key the bot **fail-opens** (logs “could not verify”, does not punish).',
  ].join('\n');
}

function buildGamerscoreManagerMessage(guildId, { content = null } = {}) {
  const guild = getGuild(guildId);
  return {
    embeds: [
      guildEmbed(guild, 'Gamerscore Manager', {
        context: 'Gamerscore detection',
      }).setDescription(
        [
          'Check Xbox gamerscore when players join a map. Low scores can be kicked or banned.',
          '',
          settingsSummary(guildId),
          '',
          setupInstructions(),
          '',
          'Pick an action below.',
        ].join('\n')
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('gscorehub:action')
          .setPlaceholder('Gamerscore manager actions')
          .addOptions(
            {
              label: 'Enable feature',
              description: 'Turn on join checks (setup channel if needed)',
              value: 'enable',
            },
            {
              label: 'Disable feature',
              description: 'Stop join gamerscore checks',
              value: 'disable',
            },
            {
              label: 'Run channel setup',
              description: 'Create/repair #gamerscore-detection',
              value: 'setup',
            },
            {
              label: 'Set minimum gamerscore',
              description: 'Players below this are punished',
              value: 'set-min',
            },
            {
              label: 'Set punishment type',
              description: 'Kick or ban (temp / permanent)',
              value: 'set-punishment',
            },
            {
              label: 'Set ban duration (minutes)',
              description: '0 = permanent ban; ignored for kick',
              value: 'set-duration',
            },
            {
              label: 'Toggle log passes',
              description: 'Also log players who meet the minimum',
              value: 'toggle-passes',
            }
          )
      ),
    ],
    content,
    ephemeral: true,
  };
}

function numberModal(customId, title, label, current, placeholder) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('value')
          .setLabel(label)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(12)
          .setValue(String(current).slice(0, 12))
          .setPlaceholder(placeholder)
      )
    );
}

async function handleGamerscoreManagerInteraction(interaction) {
  const id = interaction.customId;
  if (!id?.startsWith('gscorehub:')) return false;

  if (!canManageGamerscore(interaction)) {
    await denyGamerscore(interaction);
    return true;
  }

  const guildId = interaction.guildId;

  if (interaction.isButton() && id === 'gscorehub:back') {
    await interaction.update(buildGamerscoreManagerMessage(guildId));
    return true;
  }

  if (interaction.isStringSelectMenu() && id === 'gscorehub:action') {
    const action = interaction.values[0];
    const guild = getGuild(guildId);

    if (action === 'enable') {
      await interaction.deferUpdate();
      try {
        const wasConfigured = isFeatureConfigured(
          getGuild(guildId),
          'gamerscoreDetection'
        );
        if (!wasConfigured) {
          await setupFeature(interaction.guild, 'gamerscoreDetection');
          await postSetupReadyEmbed(interaction.guild, guildId).catch((err) =>
            console.warn('Gamerscore setup embed failed:', err.message)
          );
        }
        updateGuild(guildId, { features: { gamerscoreDetection: true } });
        await interaction.editReply(
          buildGamerscoreManagerMessage(guildId, {
            content: 'Gamerscore detection enabled.',
          })
        );
      } catch (error) {
        await interaction.editReply(
          buildGamerscoreManagerMessage(guildId, {
            content: `Enable failed: ${error.message}`,
          })
        );
      }
      return true;
    }

    if (action === 'disable') {
      updateGuild(guildId, { features: { gamerscoreDetection: false } });
      await interaction.update(
        buildGamerscoreManagerMessage(guildId, {
          content: 'Gamerscore detection disabled.',
        })
      );
      return true;
    }

    if (action === 'setup') {
      await interaction.deferUpdate();
      try {
        const result = await setupFeature(
          interaction.guild,
          'gamerscoreDetection'
        );
        await postSetupReadyEmbed(interaction.guild, guildId).catch((err) =>
          console.warn('Gamerscore setup embed failed:', err.message)
        );
        const settings = settingsFor(getGuild(guildId));
        const dest = result.channel ? `→ ${result.channel}` : '';
        await interaction.editReply(
          buildGamerscoreManagerMessage(guildId, {
            content: [
              `Setup complete ${dest}`,
              `Minimum \`${settings.minScore}\` · Punishment: **${punishmentSummary(settings)}**`,
              'Posted a ready embed in the detection channel.',
            ].join('\n'),
          })
        );
      } catch (error) {
        await interaction.editReply(
          buildGamerscoreManagerMessage(guildId, {
            content: `Setup failed: ${error.message}`,
          })
        );
      }
      return true;
    }

    if (action === 'set-min') {
      const current = settingsFor(guild).minScore;
      await interaction.showModal(
        numberModal(
          'gscorehub:modal:min',
          'Minimum gamerscore',
          'Minimum Xbox gamerscore',
          current,
          'e.g. 1000'
        )
      );
      return true;
    }

    if (action === 'set-duration') {
      const current = settingsFor(guild).durationMinutes;
      await interaction.showModal(
        numberModal(
          'gscorehub:modal:duration',
          'Ban duration (minutes)',
          'Minutes (0 = permanent ban)',
          current,
          'e.g. 60'
        )
      );
      return true;
    }

    if (action === 'set-punishment') {
      const current = settingsFor(guild).punishment;
      await interaction.update({
        embeds: [
          guildEmbed(guild, 'Punishment type', {
            context: 'Gamerscore detection',
          }).setDescription(
            [
              `Currently: **${current}**`,
              'Kick removes the player from the map. Ban uses the cluster banlist (temp or permanent).',
            ].join('\n')
          ),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('gscorehub:punishment')
              .setPlaceholder('Kick or ban')
              .addOptions(
                {
                  label: 'Kick',
                  description: 'Remove from the server (no banlist)',
                  value: 'kick',
                },
                {
                  label: 'Ban',
                  description: 'Temp or permanent via ban duration setting',
                  value: 'ban',
                }
              )
          ),
          backGamerscore(),
        ],
        content: null,
      });
      return true;
    }

    if (action === 'toggle-passes') {
      const settings = settingsFor(guild);
      updateGuild(guildId, {
        gamerscoreDetection: { logPasses: !settings.logPasses },
      });
      await interaction.update(
        buildGamerscoreManagerMessage(guildId, {
          content: `Log passes is now **${!settings.logPasses ? 'on' : 'off'}**.`,
        })
      );
      return true;
    }
  }

  if (interaction.isStringSelectMenu() && id === 'gscorehub:punishment') {
    const punishment = interaction.values[0] === 'ban' ? 'ban' : 'kick';
    updateGuild(guildId, { gamerscoreDetection: { punishment } });
    await interaction.update(
      buildGamerscoreManagerMessage(guildId, {
        content: `Punishment set to **${punishment}**.`,
      })
    );
    return true;
  }

  if (interaction.isModalSubmit() && id === 'gscorehub:modal:min') {
    const raw = interaction.fields.getTextInputValue('value');
    const value = Number(String(raw).replace(/,/g, '').trim());
    if (!Number.isFinite(value) || value < 0 || value > 50_000_000) {
      await interaction.reply({
        embeds: [
          errorEmbed('Enter a whole number between 0 and 50000000.'),
        ],
        ephemeral: true,
      });
      return true;
    }
    updateGuild(guildId, {
      gamerscoreDetection: { minScore: Math.floor(value) },
    });
    await interaction.reply({
      ...buildGamerscoreManagerMessage(guildId, {
        content: `Minimum gamerscore set to \`${Math.floor(value)}\`.`,
      }),
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isModalSubmit() && id === 'gscorehub:modal:duration') {
    const raw = interaction.fields.getTextInputValue('value');
    const value = Number(String(raw).trim());
    if (!Number.isFinite(value) || value < 0 || value > 525600) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'Enter minutes as a number from 0 (permanent) to 525600 (1 year).'
          ),
        ],
        ephemeral: true,
      });
      return true;
    }
    updateGuild(guildId, {
      gamerscoreDetection: { durationMinutes: Math.floor(value) },
    });
    await interaction.reply({
      ...buildGamerscoreManagerMessage(guildId, {
        content:
          Math.floor(value) === 0
            ? 'Ban duration set to **permanent** (0 minutes).'
            : `Ban duration set to **${Math.floor(value)}** minutes.`,
      }),
      ephemeral: true,
    });
    return true;
  }

  return false;
}

module.exports = {
  buildGamerscoreManagerMessage,
  handleGamerscoreManagerInteraction,
};

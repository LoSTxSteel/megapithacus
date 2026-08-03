const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const {
  PERMISSION_AREAS,
  getPermissions,
  setAreaRoles,
  formatAreaRoles,
  isGuildOwner,
} = require('../services/guildPermissions');
const { guildEmbed, errorEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');

const PREFIX = 'permhub:';

function denyOwner(interaction) {
  const payload = {
    embeds: [errorEmbed('Only the **Discord server owner** can edit bot permissions.')],
    ...EPHEMERAL,
  };
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(payload);
  }
  return interaction.reply(payload);
}

function backPermissions() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}back`)
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );
}

function permissionsOverview(guildId) {
  const guild = getGuild(guildId);
  const fields = Object.values(PERMISSION_AREAS).map((area) => ({
    name: area.label,
    value: [
      area.description,
      `Roles: ${formatAreaRoles(guildId, area.key)}`,
      area.commandHint,
    ].join('\n'),
  }));

  return guildEmbed(guild, 'Bot permissions', { context: 'Permissions' })
    .setDescription(
      [
        'Control which **Discord roles** can use staff bot features.',
        'Only the **server owner** can change these permissions.',
        'Members with **Manage Server** (and the owner) always have access to the features.',
        'If no roles are set for an area, only Manage Server / owner can use it.',
        '',
        'Pick an area below to set or clear roles.',
      ].join('\n')
    )
    .addFields(fields);
}

function buildPermissionsMessage(guildId, { content = null } = {}) {
  return {
    embeds: [permissionsOverview(guildId)],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${PREFIX}action`)
          .setPlaceholder('Choose a permission area')
          .addOptions(
            Object.values(PERMISSION_AREAS).map((area) => ({
              label: area.label,
              description: area.description.slice(0, 100),
              value: area.key,
            }))
          )
      ),
    ],
    content,
    ...EPHEMERAL,
  };
}

function areaEditorPanel(guildId, areaKey) {
  const meta = PERMISSION_AREAS[areaKey];
  const current = getPermissions(guildId)[areaKey] || [];

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId(`${PREFIX}set:${areaKey}`)
    .setPlaceholder(`Roles that can use ${meta.label}`)
    .setMinValues(0)
    .setMaxValues(15);

  if (current.length) {
    roleSelect.setDefaultRoles(current.slice(0, 15));
  }

  return {
    embeds: [
      guildEmbed(getGuild(guildId), `Set roles · ${meta.label}`, {
        context: 'Permissions',
      }).setDescription(
        [
          meta.description,
          '',
          `Current: ${formatAreaRoles(guildId, areaKey)}`,
          '',
          'Select the roles that should be allowed, then submit the menu.',
          'Submit with no roles selected to clear (Manage Server only).',
        ].join('\n')
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(roleSelect),
      backPermissions(),
    ],
    content: null,
  };
}

async function handlePermissionsHubInteraction(interaction) {
  const id = interaction.customId;
  if (!id?.startsWith(PREFIX)) return false;

  if (!isGuildOwner(interaction)) {
    await denyOwner(interaction);
    return true;
  }

  const guildId = interaction.guildId;

  if (interaction.isButton() && id === `${PREFIX}back`) {
    await interaction.update(buildPermissionsMessage(guildId));
    return true;
  }

  if (interaction.isStringSelectMenu() && id === `${PREFIX}action`) {
    const area = interaction.values[0];
    if (!PERMISSION_AREAS[area]) {
      await interaction.update(
        buildPermissionsMessage(guildId, { content: 'Unknown permission area.' })
      );
      return true;
    }
    await interaction.update(areaEditorPanel(guildId, area));
    return true;
  }

  if (interaction.isRoleSelectMenu() && id.startsWith(`${PREFIX}set:`)) {
    const area = id.slice(`${PREFIX}set:`.length);
    const meta = PERMISSION_AREAS[area];
    if (!meta) {
      await interaction.update(
        buildPermissionsMessage(guildId, { content: 'Unknown permission area.' })
      );
      return true;
    }

    const result = setAreaRoles(guildId, area, interaction.values);
    await interaction.update(
      buildPermissionsMessage(guildId, {
        content: result.roles.length
          ? `**${meta.label}** can be used by: ${result.roles
              .map((r) => `<@&${r}>`)
              .join(', ')}\n_(plus anyone with Manage Server)_`
          : `**${meta.label}** cleared — only **Manage Server** can use it.`,
      })
    );
    return true;
  }

  return true;
}

module.exports = {
  buildPermissionsMessage,
  handlePermissionsHubInteraction,
  permissionsOverview,
};

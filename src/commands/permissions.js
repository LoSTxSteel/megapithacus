const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  RoleSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const {
  PERMISSION_AREAS,
  getPermissions,
  setAreaRoles,
  clearAreaRoles,
  formatAreaRoles,
  isGuildOwner,
} = require('../services/guildPermissions');
const { guildEmbed, errorEmbed } = require('../utils/embeds');
const { getGuild } = require('../services/storage');

function areaChoices() {
  return Object.values(PERMISSION_AREAS).map((a) => ({
    name: a.label,
    value: a.key,
  }));
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

  return guildEmbed(guild, 'Bot permissions')
    .setDescription(
      [
        'Control which **Discord roles** can use staff bot features.',
        'Only the **server owner** can change these permissions.',
        'Members with **Manage Server** (and the owner) always have access to the features.',
        'If no roles are set for an area, only Manage Server / owner can use it.',
      ].join('\n')
    )
    .addFields(fields);
}

async function handlePermissionsInteraction(interaction) {
  const id = interaction.customId;
  if (!id?.startsWith('perm:')) return false;

  if (!isGuildOwner(interaction)) {
    const payload = {
      embeds: [errorEmbed('Only the **Discord server owner** can edit bot permissions.')],
      ephemeral: true,
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
    return true;
  }

  if (interaction.isButton() && id.startsWith('perm:cancel:')) {
    await interaction.update({
      embeds: [
        guildEmbed(getGuild(interaction.guildId), 'Cancelled').setDescription(
          'No permission changes were saved.'
        ),
      ],
      components: [],
    });
    return true;
  }

  if (interaction.isRoleSelectMenu() && id.startsWith('perm:set:')) {
    const area = id.slice('perm:set:'.length);
    const meta = PERMISSION_AREAS[area];
    if (!meta) {
      await interaction.update({
        embeds: [errorEmbed('Unknown permission area.')],
        components: [],
      });
      return true;
    }

    const result = setAreaRoles(interaction.guildId, area, interaction.values);
    await interaction.update({
      embeds: [
        guildEmbed(getGuild(interaction.guildId), 'Permissions updated').setDescription(
          result.roles.length
            ? `**${meta.label}** can be used by: ${result.roles
                .map((r) => `<@&${r}>`)
                .join(', ')}\n_(plus anyone with Manage Server)_`
            : `**${meta.label}** cleared — only **Manage Server** can use it.`
        ),
      ],
      components: [],
    });
    return true;
  }

  return false;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('permissions')
    .setDescription('Set which roles can use staff bot features')
    // Visibility hint only — execute/handlers enforce Discord server owner
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub.setName('view').setDescription('View current bot permission roles')
    )
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Choose roles allowed for a permission area')
        .addStringOption((opt) =>
          opt
            .setName('area')
            .setDescription('Which feature to configure')
            .setRequired(true)
            .addChoices(...areaChoices())
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('clear')
        .setDescription('Remove all roles from a permission area')
        .addStringOption((opt) =>
          opt
            .setName('area')
            .setDescription('Which feature to clear')
            .setRequired(true)
            .addChoices(...areaChoices())
        )
    ),

  async execute(interaction) {
    if (!isGuildOwner(interaction)) {
      await interaction.reply({
        embeds: [
          errorEmbed('Only the **Discord server owner** can edit bot permissions.'),
        ],
        ephemeral: true,
      });
      return;
    }

    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'view') {
      await interaction.reply({
        embeds: [permissionsOverview(guildId)],
        ephemeral: true,
      });
      return;
    }

    if (sub === 'clear') {
      const area = interaction.options.getString('area');
      clearAreaRoles(guildId, area);
      const meta = PERMISSION_AREAS[area];
      await interaction.reply({
        embeds: [
          guildEmbed(getGuild(guildId), 'Permissions cleared').setDescription(
            `Cleared roles for **${meta.label}**.\nOnly **Manage Server** can use it now.`
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    if (sub === 'set') {
      const area = interaction.options.getString('area');
      const meta = PERMISSION_AREAS[area];
      const current = getPermissions(guildId)[area] || [];

      const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId(`perm:set:${area}`)
        .setPlaceholder(`Roles that can use ${meta.label}`)
        .setMinValues(0)
        .setMaxValues(15);

      if (current.length) {
        roleSelect.setDefaultRoles(current.slice(0, 15));
      }

      await interaction.reply({
        embeds: [
          guildEmbed(getGuild(guildId), `Set roles · ${meta.label}`).setDescription(
            [
              meta.description,
              '',
              `Current: ${formatAreaRoles(guildId, area)}`,
              '',
              'Select the roles that should be allowed, then submit the menu.',
              'Submit with no roles selected to clear (Manage Server only).',
            ].join('\n')
          ),
        ],
        components: [
          new ActionRowBuilder().addComponents(roleSelect),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`perm:cancel:${area}`)
              .setLabel('Cancel')
              .setStyle(ButtonStyle.Secondary)
          ),
        ],
        ephemeral: true,
      });
    }
  },

  handlePermissionsInteraction,
  permissionsOverview,
};

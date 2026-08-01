const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { getGuild } = require('../services/storage');
const {
  PING_EVENTS,
  setPingRoles,
  clearPingRoles,
  getPingRoleIds,
  pingRolesSummary,
} = require('../services/pingRoles');
const { guildEmbed } = require('../utils/embeds');

function serverActionSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('mgmt:server:action')
      .setPlaceholder('Choose a server management tool')
      .addOptions({
        label: 'Ping roles',
        description: 'Roles pinged for bans, unbans, kicks, reminders',
        value: 'ping-roles',
      })
  );
}

function serverPanel(guild, categorySelect) {
  const embed = guildEmbed(guild, 'Server Management')
    .setDescription(
      [
        'Tools for how Megapithacus behaves on this Discord.',
        '',
        'Use **Ping roles** so staff roles get notified for moderation events.',
      ].join('\n')
    )
    .addFields(...pingRolesSummary(guild).slice(0, 4));

  return {
    embeds: [embed],
    components: [categorySelect('server'), serverActionSelect()],
  };
}

function pingEventSelect(selected) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('mgmt:server:ping:event')
      .setPlaceholder('Choose which event to configure')
      .addOptions(
        Object.values(PING_EVENTS).map((ev) => ({
          label: ev.label,
          description: ev.description.slice(0, 100),
          value: ev.key,
          default: selected === ev.key,
        }))
      )
  );
}

function pingRoleSelect(eventKey, currentIds) {
  const row = new RoleSelectMenuBuilder()
    .setCustomId(`mgmt:server:ping:roles:${eventKey}`)
    .setPlaceholder(`Select roles to ping for ${PING_EVENTS[eventKey].label}`)
    .setMinValues(0)
    .setMaxValues(10);

  if (currentIds?.length) {
    row.setDefaultRoles(currentIds.slice(0, 10));
  }

  return new ActionRowBuilder().addComponents(row);
}

function pingRolesPanel(guild, categorySelect, eventKey = 'ban') {
  const event = PING_EVENTS[eventKey] || PING_EVENTS.ban;
  const current = getPingRoleIds(guild, event.key);

  const embed = guildEmbed(guild, 'Ping roles')
    .setDescription(
      [
        'Choose which Discord roles get pinged when moderation events are logged.',
        'Pings post in the **Ban Logging** forum threads.',
        '',
        `Configuring: **${event.label}**`,
        event.description,
      ].join('\n')
    )
    .addFields(
      {
        name: 'Current roles',
        value: current.length
          ? current.map((id) => `<@&${id}>`).join(', ')
          : '_None — no ping for this event_',
      },
      ...pingRolesSummary(guild)
    );

  return {
    embeds: [embed],
    components: [
      categorySelect('server'),
      pingEventSelect(event.key),
      pingRoleSelect(event.key, current),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`mgmt:server:ping:clear:${event.key}`)
          .setLabel('Clear roles')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('mgmt:back:server')
          .setLabel('Back')
          .setStyle(ButtonStyle.Secondary)
      ),
    ],
  };
}

/**
 * @returns {Promise<boolean>} true if handled
 */
async function handleServerInteraction(interaction, { categorySelect }) {
  const id = interaction.customId;
  if (!id?.startsWith('mgmt:server:')) return false;

  const guildId = interaction.guildId;

  if (interaction.isStringSelectMenu() && id === 'mgmt:server:action') {
    const action = interaction.values[0];
    if (action === 'ping-roles') {
      await interaction.update({
        ...pingRolesPanel(getGuild(guildId), categorySelect, 'ban'),
        content: null,
      });
      return true;
    }
  }

  if (interaction.isStringSelectMenu() && id === 'mgmt:server:ping:event') {
    const eventKey = interaction.values[0];
    await interaction.update({
      ...pingRolesPanel(getGuild(guildId), categorySelect, eventKey),
      content: null,
    });
    return true;
  }

  if (interaction.isRoleSelectMenu() && id.startsWith('mgmt:server:ping:roles:')) {
    const eventKey = id.slice('mgmt:server:ping:roles:'.length);
    const roleIds = interaction.values;
    const result = setPingRoles(guildId, eventKey, roleIds);
    const label = PING_EVENTS[eventKey]?.label || eventKey;

    await interaction.update({
      ...pingRolesPanel(getGuild(guildId), categorySelect, eventKey),
      content: result.ok
        ? roleIds.length
          ? `Updated **${label}** ping roles: ${roleIds.map((r) => `<@&${r}>`).join(', ')}`
          : `Cleared **${label}** ping roles.`
        : result.error,
    });
    return true;
  }

  if (interaction.isButton() && id.startsWith('mgmt:server:ping:clear:')) {
    const eventKey = id.slice('mgmt:server:ping:clear:'.length);
    clearPingRoles(guildId, eventKey);
    const label = PING_EVENTS[eventKey]?.label || eventKey;
    await interaction.update({
      ...pingRolesPanel(getGuild(guildId), categorySelect, eventKey),
      content: `Cleared **${label}** ping roles.`,
    });
    return true;
  }

  return false;
}

module.exports = {
  serverPanel,
  pingRolesPanel,
  handleServerInteraction,
};

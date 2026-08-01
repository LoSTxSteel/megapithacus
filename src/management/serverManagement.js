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
const {
  canManageServerPower,
  formatAreaRoles,
} = require('../services/guildPermissions');
const {
  tokenForServer,
  startGameserver,
  stopGameserver,
  restartGameserver,
} = require('../services/nitrado');
const { guildEmbed, errorEmbed } = require('../utils/embeds');
const { ADMIN_ROLE_NAME } = require('../services/botSetup');

function serverActionSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('mgmt:server:action')
      .setPlaceholder('Choose a server management tool')
      .addOptions(
        {
          label: 'Ping roles',
          description: 'Roles pinged for bans, unbans, kicks, reminders',
          value: 'ping-roles',
        },
        {
          label: 'Server power',
          description: 'Start, stop, or restart synced Nitrado servers',
          value: 'server-power',
        }
      )
  );
}

function serverPanel(guild, categorySelect, guildId = null) {
  const id = guildId || guild.id;
  const embed = guildEmbed(guild, 'Server Management')
    .setDescription(
      [
        'Tools for how Megapithacus behaves on this Discord.',
        '',
        '• **Ping roles** — staff pings for moderation logs',
        `• **Server power** — start / stop / restart (needs **${ADMIN_ROLE_NAME}** or Manage Server)`,
      ].join('\n')
    )
    .addFields(
      {
        name: 'Server power roles',
        value: id
          ? formatAreaRoles(id, 'serverPower')
          : '_Run /setup to configure_',
      },
      ...pingRolesSummary(guild).slice(0, 3)
    );

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

function powerServerSelect(guild, selectedId = null) {
  const servers = guild.servers || [];
  const options = servers.slice(0, 25).map((s) => ({
    label: String(s.name || s.map || s.serviceId).slice(0, 100),
    description: `Nitrado \`${s.serviceId}\``.slice(0, 100),
    value: String(s.serviceId),
    default: selectedId != null && String(s.serviceId) === String(selectedId),
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('mgmt:server:power:pick')
      .setPlaceholder(
        servers.length ? 'Select a server' : 'No synced servers — sync in Server Setup'
      )
      .setDisabled(!servers.length)
      .addOptions(
        options.length
          ? options
          : [
              {
                label: 'No servers',
                value: 'none',
                description: 'Sync servers from Server Setup first',
              },
            ]
      )
  );
}

function powerActionButtons(serviceId) {
  const id = serviceId || 'none';
  const disabled = !serviceId || serviceId === 'none';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mgmt:server:power:start:${id}`)
      .setLabel('Start')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`mgmt:server:power:restart:${id}`)
      .setLabel('Restart')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`mgmt:server:power:stop:${id}`)
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('mgmt:back:server')
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );
}

function serverPowerPanel(guild, categorySelect, selectedId = null, guildId = null) {
  const id = guildId || guild.id;
  const servers = guild.servers || [];
  const selected =
    selectedId && selectedId !== 'none'
      ? servers.find((s) => String(s.serviceId) === String(selectedId))
      : null;

  const embed = guildEmbed(guild, 'Server power', { context: 'Hub' })
    .setDescription(
      [
        'Start, stop, or restart synced **Nitrado** ASE servers.',
        `Requires the **${ADMIN_ROLE_NAME}** role (or Manage Server / owner).`,
        '',
        `Allowed roles: ${
          id ? formatAreaRoles(id, 'serverPower') : '_Run /setup to configure_'
        }`,
      ].join('\n')
    )
    .addFields({
      name: 'Selected',
      value: selected
        ? `**${selected.name || selected.map || selected.serviceId}** (\`${selected.serviceId}\`)`
        : servers.length
          ? '_Pick a server below_'
          : '_No synced servers — use Server Setup → Sync servers_',
    });

  return {
    embeds: [embed],
    components: [
      categorySelect('server'),
      powerServerSelect(guild, selected?.serviceId || null),
      powerActionButtons(selected?.serviceId || null),
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
    if (action === 'server-power') {
      if (!canManageServerPower(interaction)) {
        await interaction.reply({
          embeds: [
            errorEmbed(
              `You need the **${ADMIN_ROLE_NAME}** role (or Manage Server) to use Server power.`
            ),
          ],
          ephemeral: true,
        });
        return true;
      }
      await interaction.update({
        ...serverPowerPanel(getGuild(guildId), categorySelect, null, guildId),
        content: null,
      });
      return true;
    }
  }

  if (interaction.isStringSelectMenu() && id === 'mgmt:server:power:pick') {
    if (!canManageServerPower(interaction)) {
      await interaction.reply({
        embeds: [errorEmbed('You do not have Server power access.')],
        ephemeral: true,
      });
      return true;
    }
    const serviceId = interaction.values[0];
    await interaction.update({
      ...serverPowerPanel(getGuild(guildId), categorySelect, serviceId, guildId),
      content: null,
    });
    return true;
  }

  if (interaction.isButton() && id.startsWith('mgmt:server:power:')) {
    if (!canManageServerPower(interaction)) {
      await interaction.reply({
        embeds: [errorEmbed('You do not have Server power access.')],
        ephemeral: true,
      });
      return true;
    }

    const parts = id.split(':');
    // mgmt:server:power:start:SERVICEID
    const action = parts[3];
    const serviceId = parts.slice(4).join(':');
    if (!['start', 'stop', 'restart'].includes(action) || !serviceId || serviceId === 'none') {
      return true;
    }

    const guild = getGuild(guildId);
    const server = (guild.servers || []).find(
      (s) => String(s.serviceId) === String(serviceId)
    );
    if (!server) {
      await interaction.reply({
        embeds: [errorEmbed('That server is no longer synced. Re-sync from Server Setup.')],
        ephemeral: true,
      });
      return true;
    }

    const token = tokenForServer(server, guild);
    await interaction.deferUpdate();

    try {
      if (action === 'start') await startGameserver(serviceId, token);
      else if (action === 'stop') await stopGameserver(serviceId, token);
      else await restartGameserver(serviceId, token);

      await interaction.editReply({
        ...serverPowerPanel(getGuild(guildId), categorySelect, serviceId, guildId),
        content: `✅ Sent **${action}** to **${server.name || serviceId}**.`,
      });
    } catch (error) {
      await interaction.editReply({
        ...serverPowerPanel(getGuild(guildId), categorySelect, serviceId, guildId),
        content: `❌ ${action} failed: ${error.message}`,
      });
    }
    return true;
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
  serverPowerPanel,
  handleServerInteraction,
};

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
const { canManageServerPower, formatAreaRoles } = require('../services/guildPermissions');
const {
  tokenForServer,
  startGameserver,
  stopGameserver,
  restartGameserver,
  setServerName,
  setServerPassword,
  setAdminPassword,
  queryCluster,
} = require('../services/nitrado');
const { guildEmbed, errorEmbed } = require('../utils/embeds');
const { ADMIN_ROLE_NAME } = require('../services/botSetup');

const PREFIX = 'srvman:';

function denyPower(interaction) {
  const payload = {
    embeds: [
      errorEmbed(
        `You do not have permission to manage servers.\n` +
          `Need **Manage Server**, the **${ADMIN_ROLE_NAME}** role, or a role granted under **Server power**.`
      ),
    ],
    ephemeral: true,
  };
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(payload);
  }
  return interaction.reply(payload);
}

function listServers(guild) {
  return Array.isArray(guild?.servers) ? guild.servers : [];
}

function findServer(guild, serviceId) {
  return listServers(guild).find((s) => String(s.serviceId) === String(serviceId));
}

function serverLabel(server) {
  return String(server?.name || server?.map || server?.serviceId || 'Server').slice(0, 100);
}

/** @returns {'🟢'|'🔴'|'⚪'} */
function statusIcon(result) {
  if (!result || result.ok === false) return '⚪';
  return result.online ? '🟢' : '🔴';
}

function statusLabel(result) {
  if (!result || result.ok === false) return 'Status unknown';
  return result.online ? 'Online' : 'Offline';
}

async function fetchServerStatuses(guild) {
  const servers = listServers(guild);
  const map = new Map();
  if (!servers.length) return map;

  const { results } = await queryCluster(servers, guild);
  for (const result of results) {
    map.set(String(result.serviceId), result);
  }
  return map;
}

function serversField(servers, statusMap) {
  if (!servers.length) {
    return '_No synced servers — use `/management` → Server Setup → Sync servers_';
  }
  return servers
    .slice(0, 20)
    .map((s) => {
      const icon = statusIcon(statusMap.get(String(s.serviceId)));
      return `${icon} **${serverLabel(s)}** (\`${s.serviceId}\`)`;
    })
    .join('\n')
    .slice(0, 1024);
}

function renameLocalServer(guildId, serviceId, name) {
  const guild = getGuild(guildId);
  const servers = listServers(guild).map((s) =>
    String(s.serviceId) === String(serviceId)
      ? { ...s, name: String(name).slice(0, 80) }
      : s
  );
  updateGuild(guildId, { servers });
}

function serverSelect(guild, selectedId = null, statusMap = new Map()) {
  const servers = listServers(guild);
  const options = servers.slice(0, 25).map((s) => {
    const icon = statusIcon(statusMap.get(String(s.serviceId)));
    const base = serverLabel(s);
    return {
      label: `${icon} ${base}`.slice(0, 100),
      description: `Nitrado \`${s.serviceId}\``.slice(0, 100),
      value: String(s.serviceId),
      default: selectedId != null && String(s.serviceId) === String(selectedId),
    };
  });

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${PREFIX}pick`)
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

function bulkButtons(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}bulk:restart`)
      .setLabel('Restart all')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}bulk:stop`)
      .setLabel('Stop all')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );
}

function confirmBulkRow(action) {
  const label = action === 'restart' ? 'Restart all' : 'Stop all';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}bulk:${action}:confirm`)
      .setLabel(`Confirm ${label}`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}bulk:cancel`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );
}

function serverActionButtons(serviceId) {
  const id = serviceId || 'none';
  const disabled = !serviceId || serviceId === 'none';
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}power:start:${id}`)
        .setLabel('Start')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`${PREFIX}power:stop:${id}`)
        .setLabel('Stop')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`${PREFIX}power:restart:${id}`)
        .setLabel('Restart')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}password:${id}`)
        .setLabel('Set join password')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`${PREFIX}adminpassword:${id}`)
        .setLabel('Set admin password')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`${PREFIX}name:${id}`)
        .setLabel('Change name')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`${PREFIX}back`)
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

async function buildServerManagerMessage(
  guildId,
  { selectedId = null, content = null, confirmBulk = null } = {}
) {
  const guild = getGuild(guildId);
  const servers = listServers(guild);
  const selected =
    selectedId && selectedId !== 'none' ? findServer(guild, selectedId) : null;
  const statusMap = await fetchServerStatuses(guild);

  const lines = [
    'Manage synced **Nitrado** ASE servers — power, join/admin password, and display name.',
    `Requires **Manage Server**, **${ADMIN_ROLE_NAME}**, or a **Server power** role.`,
    '',
    `Allowed roles: ${formatAreaRoles(guildId, 'serverPower')}`,
  ];

  if (confirmBulk) {
    lines.push(
      '',
      confirmBulk === 'restart'
        ? 'Confirm **Restart all** servers below.'
        : 'Confirm **Stop all** servers below.'
    );
  }

  const selectedResult = selected
    ? statusMap.get(String(selected.serviceId))
    : null;
  const selectedValue = selected
    ? `${statusIcon(selectedResult)} **${serverLabel(selected)}** (\`${selected.serviceId}\`) — ${statusLabel(selectedResult)}`
    : servers.length
      ? '_Pick a server below for controls_'
      : '_No synced servers_';

  const embed = guildEmbed(guild, 'Server Manager', { context: 'Hub' })
    .setDescription(lines.join('\n'))
    .addFields(
      {
        name: 'Servers',
        value: serversField(servers, statusMap),
      },
      {
        name: 'Selected',
        value: selectedValue,
      }
    );

  const components = [serverSelect(guild, selected?.serviceId || null, statusMap)];

  if (confirmBulk) {
    components.push(confirmBulkRow(confirmBulk));
  } else if (!selected) {
    // Restart all / Stop all only on overview (no server selected)
    components.push(bulkButtons(!servers.length));
  }

  if (selected) {
    components.push(...serverActionButtons(selected.serviceId));
  }

  return {
    embeds: [embed],
    components,
    content,
    ephemeral: true,
  };
}

function passwordModal(serviceId) {
  return new ModalBuilder()
    .setCustomId(`${PREFIX}modal:password:${serviceId}`)
    .setTitle('Set join password')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('password')
          .setLabel('Join password (empty = clear)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(64)
          .setPlaceholder('Leave blank to remove password')
      )
    );
}

function adminPasswordModal(serviceId) {
  return new ModalBuilder()
    .setCustomId(`${PREFIX}modal:adminpassword:${serviceId}`)
    .setTitle('Set admin password')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('adminpassword')
          .setLabel('Admin password (empty = clear)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(64)
          .setPlaceholder('Leave blank to remove admin password')
      )
    );
}

function nameModal(serviceId, currentName = '') {
  return new ModalBuilder()
    .setCustomId(`${PREFIX}modal:name:${serviceId}`)
    .setTitle('Change server name')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('name')
          .setLabel('Server / display name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(80)
          .setValue(String(currentName || '').slice(0, 80))
          .setPlaceholder('Shown in Nitrado / game browser')
      )
    );
}

async function runBulkPower(guild, action) {
  const servers = listServers(guild);
  const ok = [];
  const failed = [];

  for (const server of servers) {
    const token = tokenForServer(server, guild);
    const label = serverLabel(server);
    try {
      if (!token) throw new Error('No Nitrado token');
      if (action === 'stop') await stopGameserver(server.serviceId, token);
      else await restartGameserver(server.serviceId, token);
      ok.push(label);
    } catch (error) {
      failed.push(`${label}: ${error.message}`);
    }
  }

  const parts = [];
  if (ok.length) parts.push(`**${action}** sent: ${ok.join(', ')}`);
  if (failed.length) parts.push(`Failed:\n${failed.slice(0, 8).join('\n')}`);
  if (!parts.length) parts.push('No servers to update.');
  return parts.join('\n').slice(0, 1800);
}

async function refreshHub(interaction, guildId, options = {}) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate();
  }
  await interaction.editReply(await buildServerManagerMessage(guildId, options));
}

/**
 * @returns {Promise<boolean>} true if handled
 */
async function handleServerManagerInteraction(interaction) {
  const id = interaction.customId;
  if (!id?.startsWith(PREFIX)) return false;

  if (!canManageServerPower(interaction)) {
    await denyPower(interaction);
    return true;
  }

  const guildId = interaction.guildId;

  if (interaction.isButton() && id === `${PREFIX}back`) {
    await refreshHub(interaction, guildId);
    return true;
  }

  if (interaction.isStringSelectMenu() && id === `${PREFIX}pick`) {
    const serviceId = interaction.values[0];
    await refreshHub(interaction, guildId, {
      selectedId: serviceId === 'none' ? null : serviceId,
    });
    return true;
  }

  if (interaction.isButton() && id === `${PREFIX}bulk:cancel`) {
    await refreshHub(interaction, guildId);
    return true;
  }

  if (interaction.isButton() && id === `${PREFIX}bulk:restart`) {
    await refreshHub(interaction, guildId, {
      confirmBulk: 'restart',
      content: 'Confirm **Restart all** — this affects every synced server.',
    });
    return true;
  }

  if (interaction.isButton() && id === `${PREFIX}bulk:stop`) {
    await refreshHub(interaction, guildId, {
      confirmBulk: 'stop',
      content: 'Confirm **Stop all** — this affects every synced server.',
    });
    return true;
  }

  if (
    interaction.isButton() &&
    (id === `${PREFIX}bulk:restart:confirm` || id === `${PREFIX}bulk:stop:confirm`)
  ) {
    const action = id.includes(':restart:') ? 'restart' : 'stop';
    await interaction.deferUpdate();
    const summary = await runBulkPower(getGuild(guildId), action);
    await interaction.editReply(
      await buildServerManagerMessage(guildId, { content: summary })
    );
    return true;
  }

  if (interaction.isButton() && id.startsWith(`${PREFIX}power:`)) {
    const parts = id.split(':');
    // srvman:power:ACTION:SERVICEID
    const action = parts[2];
    const serviceId = parts.slice(3).join(':');
    if (!['start', 'stop', 'restart'].includes(action) || !serviceId || serviceId === 'none') {
      return true;
    }

    const guild = getGuild(guildId);
    const server = findServer(guild, serviceId);
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

      await interaction.editReply(
        await buildServerManagerMessage(guildId, {
          selectedId: serviceId,
          content: `Sent **${action}** to **${serverLabel(server)}**.`,
        })
      );
    } catch (error) {
      await interaction.editReply(
        await buildServerManagerMessage(guildId, {
          selectedId: serviceId,
          content: `${action} failed: ${error.message}`,
        })
      );
    }
    return true;
  }

  if (interaction.isButton() && id.startsWith(`${PREFIX}password:`)) {
    const serviceId = id.slice(`${PREFIX}password:`.length);
    if (!serviceId || serviceId === 'none') return true;
    if (!findServer(getGuild(guildId), serviceId)) {
      await interaction.reply({
        embeds: [errorEmbed('That server is no longer synced.')],
        ephemeral: true,
      });
      return true;
    }
    await interaction.showModal(passwordModal(serviceId));
    return true;
  }

  if (interaction.isButton() && id.startsWith(`${PREFIX}adminpassword:`)) {
    const serviceId = id.slice(`${PREFIX}adminpassword:`.length);
    if (!serviceId || serviceId === 'none') return true;
    if (!findServer(getGuild(guildId), serviceId)) {
      await interaction.reply({
        embeds: [errorEmbed('That server is no longer synced.')],
        ephemeral: true,
      });
      return true;
    }
    await interaction.showModal(adminPasswordModal(serviceId));
    return true;
  }

  if (interaction.isButton() && id.startsWith(`${PREFIX}name:`)) {
    const serviceId = id.slice(`${PREFIX}name:`.length);
    if (!serviceId || serviceId === 'none') return true;
    const server = findServer(getGuild(guildId), serviceId);
    if (!server) {
      await interaction.reply({
        embeds: [errorEmbed('That server is no longer synced.')],
        ephemeral: true,
      });
      return true;
    }
    await interaction.showModal(nameModal(serviceId, server.name || server.map || ''));
    return true;
  }

  if (interaction.isModalSubmit() && id.startsWith(`${PREFIX}modal:password:`)) {
    const serviceId = id.slice(`${PREFIX}modal:password:`.length);
    const guild = getGuild(guildId);
    const server = findServer(guild, serviceId);
    if (!server) {
      await interaction.reply({
        embeds: [errorEmbed('That server is no longer synced.')],
        ephemeral: true,
      });
      return true;
    }

    const password = interaction.fields.getTextInputValue('password') ?? '';
    const token = tokenForServer(server, guild);
    await interaction.deferUpdate();

    try {
      await setServerPassword(serviceId, token, password);
      await interaction.editReply(
        await buildServerManagerMessage(guildId, {
          selectedId: serviceId,
          content: password
            ? `Updated join password on **${serverLabel(server)}**.`
            : `Cleared join password on **${serverLabel(server)}**.`,
        })
      );
    } catch (error) {
      await interaction.editReply(
        await buildServerManagerMessage(guildId, {
          selectedId: serviceId,
          content: `Set join password failed: ${error.message}`,
        })
      );
    }
    return true;
  }

  if (interaction.isModalSubmit() && id.startsWith(`${PREFIX}modal:adminpassword:`)) {
    const serviceId = id.slice(`${PREFIX}modal:adminpassword:`.length);
    const guild = getGuild(guildId);
    const server = findServer(guild, serviceId);
    if (!server) {
      await interaction.reply({
        embeds: [errorEmbed('That server is no longer synced.')],
        ephemeral: true,
      });
      return true;
    }

    const password = interaction.fields.getTextInputValue('adminpassword') ?? '';
    const token = tokenForServer(server, guild);
    await interaction.deferUpdate();

    try {
      await setAdminPassword(serviceId, token, password);
      await interaction.editReply(
        await buildServerManagerMessage(guildId, {
          selectedId: serviceId,
          content: password
            ? `Updated admin password on **${serverLabel(server)}**.`
            : `Cleared admin password on **${serverLabel(server)}**.`,
        })
      );
    } catch (error) {
      await interaction.editReply(
        await buildServerManagerMessage(guildId, {
          selectedId: serviceId,
          content: `Set admin password failed: ${error.message}`,
        })
      );
    }
    return true;
  }

  if (interaction.isModalSubmit() && id.startsWith(`${PREFIX}modal:name:`)) {
    const serviceId = id.slice(`${PREFIX}modal:name:`.length);
    const guild = getGuild(guildId);
    const server = findServer(guild, serviceId);
    if (!server) {
      await interaction.reply({
        embeds: [errorEmbed('That server is no longer synced.')],
        ephemeral: true,
      });
      return true;
    }

    const name = (interaction.fields.getTextInputValue('name') || '').trim();
    if (!name) {
      await interaction.reply({
        embeds: [errorEmbed('Name cannot be empty.')],
        ephemeral: true,
      });
      return true;
    }

    const token = tokenForServer(server, guild);
    await interaction.deferUpdate();

    try {
      await setServerName(serviceId, token, name);
      renameLocalServer(guildId, serviceId, name);
      await interaction.editReply(
        await buildServerManagerMessage(guildId, {
          selectedId: serviceId,
          content: `Updated name to **${name.slice(0, 80)}**.`,
        })
      );
    } catch (error) {
      await interaction.editReply(
        await buildServerManagerMessage(guildId, {
          selectedId: serviceId,
          content: `Change name failed: ${error.message}`,
        })
      );
    }
    return true;
  }

  return false;
}

module.exports = {
  buildServerManagerMessage,
  handleServerManagerInteraction,
};

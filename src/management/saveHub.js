const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { EPHEMERAL } = require('../utils/ephemeral');
const { getGuild } = require('../services/storage');
const { canManageServerPower, formatAreaRoles } = require('../services/guildPermissions');
const {
  tokenForServer,
  listSaves,
  restoreSave,
  uploadSave,
  restartGameserver,
  startGameserver,
  NitradoError,
  formatBytes,
  SAVE_FILE_RE,
  getCachedSaveListMeta,
} = require('../services/nitrado');
const { guildEmbed, errorEmbed, successEmbed } = require('../utils/embeds');
const { ADMIN_ROLE_NAME } = require('../services/botSetup');

const ROLLBACK_PREFIX = 'rollback:';
const UPLOAD_PREFIX = 'upload:';

/** Discord typical attachment cap for non-boosted guilds */
const DISCORD_SOFT_LIMIT = 25 * 1024 * 1024;
const SESSION_TTL_MS = 15 * 60 * 1000;

/** @type {Map<string, any>} */
const sessions = new Map();

function sessionKey(guildId, userId, kind) {
  return `${kind}:${guildId}:${userId}`;
}

function getSession(guildId, userId, kind) {
  const key = sessionKey(guildId, userId, kind);
  const s = sessions.get(key);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    sessions.delete(key);
    return null;
  }
  return s;
}

function setSession(guildId, userId, kind, data) {
  const key = sessionKey(guildId, userId, kind);
  sessions.set(key, { ...data, expiresAt: Date.now() + SESSION_TTL_MS });
  return sessions.get(key);
}

function clearSession(guildId, userId, kind) {
  sessions.delete(sessionKey(guildId, userId, kind));
}

function denyPower(interaction) {
  const payload = {
    embeds: [
      errorEmbed(
        `You do not have permission to manage servers.\n` +
          `Need **Manage Server**, the **${ADMIN_ROLE_NAME}** role, or a role granted under **Server power**.`
      ),
    ],
    ...EPHEMERAL,
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

function isGenericServerLabel(name) {
  const s = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
  return !s || s === 'game server' || s === 'gameserver' || s === 'gameservers' || s === 'server';
}

function serverLabel(server) {
  for (const value of [server?.name, server?.label, server?.map]) {
    if (value == null) continue;
    const trimmed = String(value).trim();
    if (!trimmed || isGenericServerLabel(trimmed)) continue;
    return trimmed.slice(0, 100);
  }
  return String(server?.serviceId || 'Server').slice(0, 100);
}

function serverSelectRow(guild, customId, selectedId = null) {
  const servers = listServers(guild);
  const options = servers.slice(0, 25).map((s) => ({
    label: serverLabel(s).slice(0, 100),
    description: `Nitrado \`${s.serviceId}\``.slice(0, 100),
    value: String(s.serviceId),
    default: selectedId != null && String(s.serviceId) === String(selectedId),
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
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

function permFooter(guildId) {
  return [
    `Requires **Manage Server**, **${ADMIN_ROLE_NAME}**, or a **Server power** role.`,
    `Allowed roles: ${formatAreaRoles(guildId, 'serverPower')}`,
  ].join('\n');
}

// ── /rollback ──────────────────────────────────────────────────────────────

async function buildRollbackMessage(guildId, userId, options = {}) {
  const guild = getGuild(guildId);
  const servers = listServers(guild);
  const session = getSession(guildId, userId, 'rollback') || {};
  const serviceId = options.serviceId ?? session.serviceId ?? null;
  const server = serviceId ? findServer(guild, serviceId) : null;
  const saves = options.saves ?? session.saves ?? null;
  const selectedSave = options.selectedSave ?? session.selectedSave ?? null;
  const confirm = Boolean(options.confirm);
  const listError = options.listError || session.listError || null;
  const meta = serviceId ? getCachedSaveListMeta(serviceId) : null;

  const lines = [
    'Roll back an ASE (arkxb) map using **Nitrado gameserver backups** or dated **SavedArks** files.',
    permFooter(guildId),
    '',
    '1. Select a server',
    '2. Pick a past save / backup',
    '3. Confirm restore',
  ];

  if (listError) {
    lines.push('', `⚠ List warning: ${listError}`);
  }
  if (meta?.errors?.length && !listError) {
    lines.push('', `⚠ Partial list: ${meta.errors.slice(0, 2).join(' · ')}`);
  }

  const embed = guildEmbed(guild, 'Save Rollback', { context: 'Hub' }).setDescription(
    lines.join('\n')
  );

  if (server) {
    embed.addFields({
      name: 'Server',
      value: `**${serverLabel(server)}** (\`${server.serviceId}\`)`,
    });
  }

  if (saves?.length) {
    const preview = saves
      .slice(0, 12)
      .map((s, i) => `\`${i + 1}.\` ${s.label.slice(0, 90)}`)
      .join('\n')
      .slice(0, 1024);
    embed.addFields({
      name: `Available saves (${saves.length})`,
      value: preview || '_None_',
    });
  } else if (server && options.loaded) {
    embed.addFields({
      name: 'Available saves',
      value:
        '_No backups or dated `.ark` files found._\n' +
        'Nitrado daily backups appear under Tools → Restore Backup; game auto-saves live in `Saved/SavedArks`.',
    });
  }

  if (selectedSave) {
    embed.addFields({
      name: 'Selected',
      value: selectedSave.label.slice(0, 1024),
    });
  }

  if (confirm && selectedSave) {
    const warn =
      selectedSave.kind === 'nitrado'
        ? 'This runs Nitrado’s **gameserver backup restore**. It can take **10–30 minutes** and may change IP / settings.'
        : `This will **stop** the server, copy \`${selectedSave.name}\` → \`${selectedSave.targetName || 'map.ark'}\`, then **start** it.`;
    embed.addFields({
      name: 'Confirm restore',
      value: warn,
    });
  }

  const components = [serverSelectRow(guild, `${ROLLBACK_PREFIX}pick`, serviceId)];

  if (server && saves?.length) {
    const opts = saves.slice(0, 25).map((s) => ({
      label: s.label.slice(0, 100),
      description: (s.kind === 'nitrado' ? 'Nitrado backup' : 'SavedArks file').slice(0, 100),
      value: s.selectValue,
      default: selectedSave?.selectValue === s.selectValue,
    }));
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${ROLLBACK_PREFIX}save`)
          .setPlaceholder('Select a past save / backup')
          .addOptions(opts)
      )
    );
  }

  if (confirm && selectedSave) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${ROLLBACK_PREFIX}confirm`)
          .setLabel('Confirm restore')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`${ROLLBACK_PREFIX}cancel`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      )
    );
  } else if (selectedSave) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${ROLLBACK_PREFIX}ask`)
          .setLabel('Review & confirm')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`${ROLLBACK_PREFIX}cancel`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      )
    );
  }

  return {
    embeds: [embed],
    components,
    ...EPHEMERAL,
  };
}

async function openRollbackHub(interaction) {
  const guildId = interaction.guildId;
  clearSession(guildId, interaction.user.id, 'rollback');
  setSession(guildId, interaction.user.id, 'rollback', {});
  return buildRollbackMessage(guildId, interaction.user.id);
}

async function handleRollbackInteraction(interaction) {
  const id = interaction.customId;
  if (!id?.startsWith(ROLLBACK_PREFIX)) return false;

  if (!canManageServerPower(interaction)) {
    await denyPower(interaction);
    return true;
  }

  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const guild = getGuild(guildId);

  if (interaction.isStringSelectMenu() && id === `${ROLLBACK_PREFIX}pick`) {
    const serviceId = interaction.values[0];
    if (serviceId === 'none') {
      await interaction.update(await buildRollbackMessage(guildId, userId));
      return true;
    }

    await interaction.deferUpdate();
    const server = findServer(guild, serviceId);
    const token = tokenForServer(server, guild);
    if (!server || !token) {
      setSession(guildId, userId, 'rollback', {
        serviceId,
        listError: 'No Nitrado token for this server.',
        saves: [],
      });
      await interaction.editReply(
        await buildRollbackMessage(guildId, userId, {
          serviceId,
          loaded: true,
          listError: 'No Nitrado token for this server.',
          saves: [],
        })
      );
      return true;
    }

    try {
      const saves = await listSaves(serviceId, token);
      setSession(guildId, userId, 'rollback', {
        serviceId,
        saves,
        selectedSave: null,
        listError: null,
      });
      await interaction.editReply(
        await buildRollbackMessage(guildId, userId, {
          serviceId,
          saves,
          loaded: true,
        })
      );
    } catch (error) {
      setSession(guildId, userId, 'rollback', {
        serviceId,
        saves: [],
        listError: error.message,
      });
      await interaction.editReply(
        await buildRollbackMessage(guildId, userId, {
          serviceId,
          saves: [],
          loaded: true,
          listError: error.message,
        })
      );
    }
    return true;
  }

  if (interaction.isStringSelectMenu() && id === `${ROLLBACK_PREFIX}save`) {
    const session = getSession(guildId, userId, 'rollback');
    if (!session?.saves?.length) {
      await interaction.reply({
        embeds: [errorEmbed('Session expired. Run `/rollback` again.')],
        ...EPHEMERAL,
      });
      return true;
    }
    const selectedSave = session.saves.find((s) => s.selectValue === interaction.values[0]);
    if (!selectedSave) {
      await interaction.reply({
        embeds: [errorEmbed('That save is no longer in the list. Pick again.')],
        ...EPHEMERAL,
      });
      return true;
    }
    setSession(guildId, userId, 'rollback', {
      ...session,
      selectedSave,
    });
    await interaction.update(
      await buildRollbackMessage(guildId, userId, {
        serviceId: session.serviceId,
        saves: session.saves,
        selectedSave,
      })
    );
    return true;
  }

  if (interaction.isButton() && id === `${ROLLBACK_PREFIX}ask`) {
    const session = getSession(guildId, userId, 'rollback');
    if (!session?.selectedSave) {
      await interaction.reply({
        embeds: [errorEmbed('Pick a save first.')],
        ...EPHEMERAL,
      });
      return true;
    }
    await interaction.update(
      await buildRollbackMessage(guildId, userId, {
        serviceId: session.serviceId,
        saves: session.saves,
        selectedSave: session.selectedSave,
        confirm: true,
      })
    );
    return true;
  }

  if (interaction.isButton() && id === `${ROLLBACK_PREFIX}cancel`) {
    clearSession(guildId, userId, 'rollback');
    await interaction.update(await openRollbackHub(interaction));
    return true;
  }

  if (interaction.isButton() && id === `${ROLLBACK_PREFIX}confirm`) {
    const session = getSession(guildId, userId, 'rollback');
    const save = session?.selectedSave;
    const serviceId = session?.serviceId;
    const server = serviceId ? findServer(guild, serviceId) : null;
    const token = server ? tokenForServer(server, guild) : null;

    if (!save || !server || !token) {
      await interaction.reply({
        embeds: [errorEmbed('Session expired or server missing. Run `/rollback` again.')],
        ...EPHEMERAL,
      });
      return true;
    }

    await interaction.deferUpdate();
    try {
      const result = await restoreSave(serviceId, token, save, { startAfter: true });
      clearSession(guildId, userId, 'rollback');

      const parts = [
        `Restore requested for **${serverLabel(server)}** (\`${serviceId}\`).`,
        `Save: ${save.label}`,
      ];
      if (result.kind === 'ark') {
        parts.push(
          `Copied \`${result.sourceName}\` → \`${result.targetName}\`.`,
          result.started
            ? 'Server **start** sent after restore.'
            : 'Server was not started — use `/servermanager` to start.'
        );
      } else {
        parts.push(
          result.warning ||
            'Nitrado gameserver restore accepted. Wait for the panel job to finish.',
          'Use `/servermanager` to **start/restart** if the server stays offline.'
        );
      }

      const components = [];
      if (result.needsRestart || result.kind === 'nitrado') {
        components.push(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`${ROLLBACK_PREFIX}restart:${serviceId}`)
              .setLabel('Restart server now')
              .setStyle(ButtonStyle.Primary)
          )
        );
        setSession(guildId, userId, 'rollback', { serviceId, postRestore: true });
      }

      await interaction.editReply({
        embeds: [successEmbed('Rollback submitted', parts.join('\n'), guild)],
        components,
        ...EPHEMERAL,
      });
    } catch (error) {
      await interaction.editReply({
        embeds: [
          errorEmbed(
            `Restore **failed** — nothing was faked as success.\n${error.message || error}`
          ),
        ],
        components: [],
        ...EPHEMERAL,
      });
    }
    return true;
  }

  if (interaction.isButton() && id.startsWith(`${ROLLBACK_PREFIX}restart:`)) {
    const serviceId = id.slice(`${ROLLBACK_PREFIX}restart:`.length);
    const server = findServer(guild, serviceId);
    const token = server ? tokenForServer(server, guild) : null;
    if (!server || !token) {
      await interaction.reply({
        embeds: [errorEmbed('Server or token missing.')],
        ...EPHEMERAL,
      });
      return true;
    }
    await interaction.deferUpdate();
    try {
      try {
        await restartGameserver(serviceId, token);
      } catch {
        await startGameserver(serviceId, token);
      }
      await interaction.editReply({
        embeds: [
          successEmbed(
            'Restart sent',
            `Restart/start sent for **${serverLabel(server)}** (\`${serviceId}\`).`,
            guild
          ),
        ],
        components: [],
        ...EPHEMERAL,
      });
      clearSession(guildId, userId, 'rollback');
    } catch (error) {
      await interaction.editReply({
        embeds: [errorEmbed(`Restart failed: ${error.message}`)],
        components: [],
        ...EPHEMERAL,
      });
    }
    return true;
  }

  return true;
}

// ── /upload ────────────────────────────────────────────────────────────────

function validateAttachment(attachment) {
  if (!attachment) return { ok: false, error: 'No attachment provided.' };
  const name = String(attachment.name || 'save.ark');
  if (!SAVE_FILE_RE.test(name)) {
    return {
      ok: false,
      error: `Unsupported file \`${name}\`. Upload a \`.ark\` map save (or \`.arktribe\` / \`.bak\`).`,
    };
  }
  const size = Number(attachment.size || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, error: 'Attachment has no size — Discord may not have finished uploading.' };
  }
  // Soft warn only — Discord enforces hard caps per guild boost tier.
  const warnings = [];
  if (size > DISCORD_SOFT_LIMIT) {
    warnings.push(
      `File is **${formatBytes(size)}**. Non-boosted Discord uploads are usually capped at **25 MB**; ` +
        `boosted servers allow more. Huge ASE maps often exceed Discord limits — use Nitrado FTP/File Browser for multi‑hundred‑MB saves.`
    );
  } else {
    warnings.push(
      `Discord attachment limits apply (typically **25 MB** without Nitro boost). This file is **${formatBytes(size)}**.`
    );
  }
  return { ok: true, name, size, url: attachment.url, warnings };
}

async function buildUploadMessage(guildId, userId, options = {}) {
  const guild = getGuild(guildId);
  const session = getSession(guildId, userId, 'upload') || {};
  const serviceId = options.serviceId ?? session.serviceId ?? null;
  const server = serviceId ? findServer(guild, serviceId) : null;
  const file = options.file ?? session.file ?? null;
  const confirm = Boolean(options.confirm);

  const lines = [
    'Upload a custom ASE save into Nitrado **SavedArks** (stop → replace → start).',
    permFooter(guildId),
    '',
    '⚠ **Wrong files can break the map.** Confirm the filename matches the map (e.g. `TheIsland.ark`).',
  ];

  if (file?.warnings?.length) {
    lines.push('', ...file.warnings);
  }

  const embed = guildEmbed(guild, 'Save Upload', { context: 'Hub' }).setDescription(
    lines.join('\n')
  );

  if (file) {
    embed.addFields({
      name: 'Attachment',
      value: `\`${file.name}\` · ${formatBytes(file.size) || 'unknown size'}`,
    });
  }

  if (server) {
    embed.addFields({
      name: 'Target server',
      value: `**${serverLabel(server)}** (\`${server.serviceId}\`)`,
    });
  }

  if (confirm && server && file) {
    embed.addFields({
      name: 'Confirm upload',
      value:
        `This will **stop** the server, upload \`${file.name}\` into SavedArks (overwrite if present), then **start** it.\n` +
        'This cannot be undone from Discord — keep your own backup.',
    });
  }

  const components = [serverSelectRow(guild, `${UPLOAD_PREFIX}pick`, serviceId)];

  if (server && file && confirm) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${UPLOAD_PREFIX}confirm`)
          .setLabel('Confirm upload')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`${UPLOAD_PREFIX}cancel`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      )
    );
  } else if (server && file) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${UPLOAD_PREFIX}ask`)
          .setLabel('Review & confirm')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`${UPLOAD_PREFIX}cancel`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      )
    );
  }

  return {
    embeds: [embed],
    components,
    ...EPHEMERAL,
  };
}

async function openUploadHub(interaction, attachment) {
  const guildId = interaction.guildId;
  const checked = validateAttachment(attachment);
  if (!checked.ok) {
    return {
      embeds: [errorEmbed(checked.error)],
      components: [],
      ...EPHEMERAL,
    };
  }

  setSession(guildId, interaction.user.id, 'upload', {
    file: {
      name: checked.name,
      size: checked.size,
      url: checked.url,
      warnings: checked.warnings,
    },
  });

  return buildUploadMessage(guildId, interaction.user.id, {
    file: {
      name: checked.name,
      size: checked.size,
      url: checked.url,
      warnings: checked.warnings,
    },
  });
}

async function downloadAttachmentBuffer(url, maxBytes = 512 * 1024 * 1024) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new NitradoError(`Failed to download Discord attachment (${res.status})`, res.status);
  }
  const len = Number(res.headers.get('content-length') || 0);
  if (len > maxBytes) {
    throw new NitradoError(
      `Attachment too large to process in-bot (${formatBytes(len)}). Use Nitrado FTP for huge saves.`,
      413
    );
  }
  const ab = await res.arrayBuffer();
  if (ab.byteLength > maxBytes) {
    throw new NitradoError(
      `Attachment too large to process in-bot (${formatBytes(ab.byteLength)}).`,
      413
    );
  }
  return Buffer.from(ab);
}

async function handleUploadInteraction(interaction) {
  const id = interaction.customId;
  if (!id?.startsWith(UPLOAD_PREFIX)) return false;

  if (!canManageServerPower(interaction)) {
    await denyPower(interaction);
    return true;
  }

  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const guild = getGuild(guildId);

  if (interaction.isStringSelectMenu() && id === `${UPLOAD_PREFIX}pick`) {
    const serviceId = interaction.values[0];
    const session = getSession(guildId, userId, 'upload');
    if (!session?.file) {
      await interaction.reply({
        embeds: [errorEmbed('Session expired. Run `/upload` with the save attachment again.')],
        ...EPHEMERAL,
      });
      return true;
    }
    if (serviceId === 'none') {
      await interaction.update(await buildUploadMessage(guildId, userId));
      return true;
    }
    setSession(guildId, userId, 'upload', { ...session, serviceId });
    await interaction.update(
      await buildUploadMessage(guildId, userId, {
        serviceId,
        file: session.file,
      })
    );
    return true;
  }

  if (interaction.isButton() && id === `${UPLOAD_PREFIX}ask`) {
    const session = getSession(guildId, userId, 'upload');
    if (!session?.file || !session?.serviceId) {
      await interaction.reply({
        embeds: [errorEmbed('Select a server first (or re-run `/upload`).')],
        ...EPHEMERAL,
      });
      return true;
    }
    await interaction.update(
      await buildUploadMessage(guildId, userId, {
        serviceId: session.serviceId,
        file: session.file,
        confirm: true,
      })
    );
    return true;
  }

  if (interaction.isButton() && id === `${UPLOAD_PREFIX}cancel`) {
    clearSession(guildId, userId, 'upload');
    await interaction.update({
      embeds: [guildEmbed(getGuild(guildId), 'Upload cancelled', { context: 'Hub' })
        .setDescription('Upload cancelled. Run `/upload` again if needed.')],
      components: [],
      ...EPHEMERAL,
    });
    return true;
  }

  if (interaction.isButton() && id === `${UPLOAD_PREFIX}confirm`) {
    const session = getSession(guildId, userId, 'upload');
    const serviceId = session?.serviceId;
    const file = session?.file;
    const server = serviceId ? findServer(guild, serviceId) : null;
    const token = server ? tokenForServer(server, guild) : null;

    if (!file || !server || !token) {
      await interaction.reply({
        embeds: [errorEmbed('Session expired or server missing. Run `/upload` again.')],
        ...EPHEMERAL,
      });
      return true;
    }

    await interaction.deferUpdate();
    try {
      const buffer = await downloadAttachmentBuffer(file.url);
      const result = await uploadSave(serviceId, token, buffer, file.name, {
        stopFirst: true,
        startAfter: true,
      });
      clearSession(guildId, userId, 'upload');

      const parts = [
        `Uploaded \`${result.fileName}\` (${formatBytes(result.bytes)}) to **${serverLabel(server)}**.`,
        `Path: \`${result.dir}/${result.fileName}\``,
        result.started
          ? 'Server was **stopped**, file replaced, then **start** was sent.'
          : 'File uploaded but start was not sent — use `/servermanager`.',
      ];

      await interaction.editReply({
        embeds: [successEmbed('Upload complete', parts.join('\n'), guild)],
        components: [],
        ...EPHEMERAL,
      });
    } catch (error) {
      await interaction.editReply({
        embeds: [
          errorEmbed(
            `Upload **failed** — nothing was faked as success.\n${error.message || error}`
          ),
        ],
        components: [],
        ...EPHEMERAL,
      });
    }
    return true;
  }

  return true;
}

async function handleSaveHubInteraction(interaction) {
  if (await handleRollbackInteraction(interaction)) return true;
  if (await handleUploadInteraction(interaction)) return true;
  return false;
}

module.exports = {
  openRollbackHub,
  openUploadHub,
  handleSaveHubInteraction,
  handleRollbackInteraction,
  handleUploadInteraction,
  DISCORD_SOFT_LIMIT,
};

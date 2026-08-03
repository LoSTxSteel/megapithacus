const {
  ApplicationCommandPermissionType,
  Routes,
  REST,
} = require('discord.js');
const config = require('../config');
const { getAdminPay } = require('./adminPay');
const { getGuild } = require('./storage');

/**
 * Discord Permissions v2: role/user overwrites require a *user* Bearer token
 * with scope `applications.commands.permissions.update` (bot tokens are rejected).
 * Set DISCORD_COMMAND_PERMISSIONS_TOKEN in .env for automatic sync.
 *
 * Baseline visibility still uses defaultMemberPermissions: 0 on /pay
 * (Administrators always see it).
 */
function permissionsBearer() {
  const raw =
    process.env.DISCORD_COMMAND_PERMISSIONS_TOKEN ||
    process.env.DISCORD_PERMISSIONS_BEARER ||
    '';
  return String(raw).trim() || null;
}

async function findPayCommandId(guild) {
  try {
    const guildCmds = await guild.commands.fetch();
    const local = guildCmds.find((c) => c.name === 'pay');
    if (local) return local.id;
  } catch {
    // fall through
  }

  try {
    if (!guild.client.application?.commands) {
      await guild.client.application?.fetch?.();
    }
    const globalCmds = await guild.client.application.commands.fetch();
    const global = globalCmds.find((c) => c.name === 'pay');
    if (global) return global.id;
  } catch {
    // fall through
  }

  // REST fallback using configured client id
  try {
    const rest = new REST({ version: '10' }).setToken(config.token());
    const clientId = config.clientId();
    const guildId = config.guildId || guild.id;
    const list = config.guildId
      ? await rest.get(Routes.applicationGuildCommands(clientId, guildId))
      : await rest.get(Routes.applicationCommands(clientId));
    const found = (list || []).find((c) => c.name === 'pay');
    return found?.id || null;
  } catch {
    return null;
  }
}

function buildPayPermissionOverwrites(guildId) {
  const pay = getAdminPay(guildId);
  const permissions = [
    // Deny @everyone (guild id == @everyone role id)
    {
      id: String(guildId),
      type: ApplicationCommandPermissionType.Role,
      permission: false,
    },
  ];

  const allowed = new Set((pay.payRoleIds || []).map(String));
  const setupRoleId = getGuild(guildId)?.botSetupRoleId;
  if (setupRoleId) allowed.add(String(setupRoleId));

  for (const roleId of allowed) {
    if (!roleId || roleId === String(guildId)) continue;
    permissions.push({
      id: roleId,
      type: ApplicationCommandPermissionType.Role,
      permission: true,
    });
  }

  return permissions.slice(0, 100);
}

/**
 * Sync /pay command role allows for a guild from stored payRoleIds.
 * @param {import('discord.js').Guild} guild
 */
async function syncPayCommandPermissions(guild) {
  if (!guild?.id) {
    return { ok: false, error: 'No guild.' };
  }

  const bearer = permissionsBearer();
  if (!bearer) {
    return {
      ok: false,
      reason: 'no_bearer',
      error:
        'No DISCORD_COMMAND_PERMISSIONS_TOKEN set. /pay stays admin-only until a Bearer token with applications.commands.permissions.update is configured, or an admin enables roles under Server Settings → Integrations.',
    };
  }

  const commandId = await findPayCommandId(guild);
  if (!commandId) {
    return { ok: false, error: 'Could not find the /pay command id after deploy.' };
  }

  const permissions = buildPayPermissionOverwrites(guild.id);

  try {
    await guild.client.application.commands.permissions.set({
      guild: guild.id,
      command: commandId,
      token: bearer,
      permissions,
    });
    return {
      ok: true,
      commandId,
      roleAllows: permissions.filter((p) => p.permission).length,
    };
  } catch (error) {
    console.warn(
      `syncPayCommandPermissions failed for ${guild.id}:`,
      error.message
    );
    return {
      ok: false,
      error: error.message || 'Failed to update /pay command permissions.',
    };
  }
}

async function syncAllGuildPayCommandPermissions(client) {
  let synced = 0;
  let skipped = 0;
  for (const guild of client.guilds.cache.values()) {
    const result = await syncPayCommandPermissions(guild);
    if (result.ok) synced += 1;
    else skipped += 1;
  }
  console.log(
    `Pay command permissions: synced ${synced}, skipped/failed ${skipped} guild(s)`
  );
  return { synced, skipped };
}

module.exports = {
  syncPayCommandPermissions,
  syncAllGuildPayCommandPermissions,
  permissionsBearer,
  findPayCommandId,
};

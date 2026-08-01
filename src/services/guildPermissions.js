const { PermissionFlagsBits } = require('discord.js');
const { getGuild, updateGuild } = require('./storage');

const PERMISSION_AREAS = {
  adminPay: {
    key: 'adminPay',
    label: 'Admin Pay',
    description: 'Add/update paid admins, log work, credits, and payouts',
    commandHint: '`/adminpay manage` or `/adminpay board`',
  },
  donations: {
    key: 'donations',
    label: 'Donations',
    description: 'Manage donation methods and post / confirm donation embeds',
    commandHint: '`/donatemanage` or `/donate`',
  },
  serverPower: {
    key: 'serverPower',
    label: 'Server power',
    description: 'Start, stop, and restart Nitrado ASE game servers',
    commandHint: '`/management` → Server Management → Server power',
  },
};

function defaultPermissions() {
  return {
    adminPay: [],
    donations: [],
    serverPower: [],
  };
}

function getPermissions(guildId) {
  const guild = getGuild(guildId);
  return {
    ...defaultPermissions(),
    ...(guild.permissions || {}),
    adminPay: [...(guild.permissions?.adminPay || [])],
    donations: [...(guild.permissions?.donations || [])],
  };
}

function setAreaRoles(guildId, areaKey, roleIds) {
  if (!PERMISSION_AREAS[areaKey]) {
    return { ok: false, error: 'Unknown permission area.' };
  }
  const unique = [...new Set((roleIds || []).map(String))].slice(0, 15);
  const permissions = {
    ...getPermissions(guildId),
    [areaKey]: unique,
  };
  updateGuild(guildId, { permissions });
  return { ok: true, roles: unique, permissions };
}

function clearAreaRoles(guildId, areaKey) {
  return setAreaRoles(guildId, areaKey, []);
}

function memberHasManageGuild(interaction) {
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  );
}

function isGuildOwner(interaction) {
  return Boolean(
    interaction.guild?.ownerId &&
      interaction.user?.id &&
      interaction.guild.ownerId === interaction.user.id
  );
}

/**
 * Manage Server / owner always allowed. Otherwise member must have one of the
 * configured roles for that area. If no roles are configured, only Manage Server.
 */
function canAccessArea(interaction, areaKey) {
  if (isGuildOwner(interaction) || memberHasManageGuild(interaction)) return true;

  const roles = getPermissions(interaction.guildId)[areaKey] || [];
  if (!roles.length) return false;

  const memberRoles = interaction.member?.roles;
  if (!memberRoles) return false;

  // GuildMemberRoleManager (cache) or API interaction member
  if (typeof memberRoles.cache?.has === 'function') {
    return roles.some((id) => memberRoles.cache.has(id));
  }
  if (Array.isArray(memberRoles)) {
    // API interaction: roles is string[]
    return roles.some((id) => memberRoles.includes(id));
  }
  return false;
}

function canManageAdminPay(interaction) {
  return canAccessArea(interaction, 'adminPay');
}

function canManageDonations(interaction) {
  return canAccessArea(interaction, 'donations');
}

function canManageServerPower(interaction) {
  return canAccessArea(interaction, 'serverPower');
}

function formatAreaRoles(guildId, areaKey) {
  const roles = getPermissions(guildId)[areaKey] || [];
  if (!roles.length) {
    return '_None — only members with **Manage Server** can use this._';
  }
  return roles.map((id) => `<@&${id}>`).join(', ');
}

module.exports = {
  PERMISSION_AREAS,
  defaultPermissions,
  getPermissions,
  setAreaRoles,
  clearAreaRoles,
  memberHasManageGuild,
  isGuildOwner,
  canAccessArea,
  canManageAdminPay,
  canManageDonations,
  canManageServerPower,
  formatAreaRoles,
};

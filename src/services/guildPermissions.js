const { PermissionFlagsBits } = require('discord.js');
const { getGuild, updateGuild } = require('./storage');

const PERMISSION_AREAS = {
  donations: {
    key: 'donations',
    label: 'Donations',
    description: 'Manage donation methods and post / confirm donation embeds',
    commandHint: '`/donatemanage` or `/donate`',
  },
  serverPower: {
    key: 'serverPower',
    label: 'Server power',
    description: 'Start, stop, restart, and manage ASE saves on Nitrado',
    commandHint:
      '`/servermanager`, `/rollback`, `/upload`, or `/management` → Server Management → Server power',
  },
  rewardManager: {
    key: 'rewardManager',
    label: 'Reward manager',
    description: 'Configure boost and invite rewards (channels, credit, thresholds)',
    commandHint: '`/rewardmanager`',
  },
  creditManager: {
    key: 'creditManager',
    label: 'Credit manager',
    description: 'Add, remove, wipe, and view player credits',
    commandHint: '`/creditmanager` or `/creditview`',
  },
  gamerscoreManager: {
    key: 'gamerscoreManager',
    label: 'Gamerscore manager',
    description: 'Configure Xbox gamerscore join checks and punishments',
    commandHint: '`/gamerscoremanager`',
  },
  spoofManager: {
    key: 'spoofManager',
    label: 'Spoof manager',
    description: 'Configure Xbox gamertag spoof / name mismatch detection',
    commandHint: '`/spoofmanager`',
  },
  adminPay: {
    key: 'adminPay',
    label: 'Admin Pay',
    description: 'Configure admin pay rates and review payout requests',
    commandHint: '`/adminpay`',
  },
};

function defaultPermissions() {
  return {
    donations: [],
    serverPower: [],
    rewardManager: [],
    creditManager: [],
    gamerscoreManager: [],
    spoofManager: [],
    adminPay: [],
  };
}

function getPermissions(guildId) {
  const guild = getGuild(guildId);
  return {
    ...defaultPermissions(),
    ...(guild.permissions || {}),
    donations: [...(guild.permissions?.donations || [])],
    serverPower: [...(guild.permissions?.serverPower || [])],
    rewardManager: [...(guild.permissions?.rewardManager || [])],
    creditManager: [...(guild.permissions?.creditManager || [])],
    gamerscoreManager: [...(guild.permissions?.gamerscoreManager || [])],
    spoofManager: [...(guild.permissions?.spoofManager || [])],
    adminPay: [...(guild.permissions?.adminPay || [])],
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

function memberHasAnyRole(interaction, roleIds) {
  const roles = (roleIds || []).map(String).filter(Boolean);
  if (!roles.length) return false;

  const memberRoles = interaction.member?.roles;
  if (!memberRoles) return false;

  if (typeof memberRoles.cache?.has === 'function') {
    return roles.some((id) => memberRoles.cache.has(id));
  }
  if (Array.isArray(memberRoles)) {
    return roles.some((id) => memberRoles.includes(id));
  }
  return false;
}

function memberHasBotSetupRole(interaction) {
  const roleId = getGuild(interaction.guildId)?.botSetupRoleId;
  if (!roleId) return false;
  return memberHasAnyRole(interaction, [roleId]);
}

/**
 * Manage Server / owner always allowed. Otherwise member must have one of the
 * configured roles for that area. If no roles are configured, only Manage Server.
 */
function canAccessArea(interaction, areaKey) {
  if (isGuildOwner(interaction) || memberHasManageGuild(interaction)) return true;

  const roles = getPermissions(interaction.guildId)[areaKey] || [];
  if (!roles.length) return false;

  return memberHasAnyRole(interaction, roles);
}

function canManageDonations(interaction) {
  return canAccessArea(interaction, 'donations');
}

function canManageServerPower(interaction) {
  return canAccessArea(interaction, 'serverPower');
}

function canManageRewards(interaction) {
  return canAccessArea(interaction, 'rewardManager');
}

function canManageCredits(interaction) {
  return canAccessArea(interaction, 'creditManager');
}

function canManageGamerscore(interaction) {
  return canAccessArea(interaction, 'gamerscoreManager');
}

function canManageSpoof(interaction) {
  return canAccessArea(interaction, 'spoofManager');
}

function canManageAdminPay(interaction) {
  if (memberHasBotSetupRole(interaction)) return true;
  return canAccessArea(interaction, 'adminPay');
}

function canUsePay(interaction) {
  if (isGuildOwner(interaction) || memberHasManageGuild(interaction)) return true;
  if (memberHasBotSetupRole(interaction)) return true;

  const { getAdminPay } = require('./adminPay');
  const payRoles = getAdminPay(interaction.guildId)?.payRoleIds || [];
  return memberHasAnyRole(interaction, payRoles);
}

/**
 * Player ban / unban / kick (slash + playersearch wizard).
 * Manage Server, bot setup role, or Discord Ban Members.
 */
function canModeratePlayers(interaction) {
  if (isGuildOwner(interaction) || memberHasManageGuild(interaction)) return true;
  if (memberHasBotSetupRole(interaction)) return true;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers)) {
    return true;
  }
  return false;
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
  memberHasBotSetupRole,
  memberHasAnyRole,
  isGuildOwner,
  canAccessArea,
  canManageDonations,
  canManageServerPower,
  canManageRewards,
  canManageCredits,
  canManageGamerscore,
  canManageSpoof,
  canManageAdminPay,
  canUsePay,
  canModeratePlayers,
  formatAreaRoles,
};

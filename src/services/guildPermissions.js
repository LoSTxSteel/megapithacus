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
    description: 'Start, stop, and restart Nitrado ASE game servers',
    commandHint: '`/servermanager` or `/management` → Server Management → Server power',
  },
  rewardManager: {
    key: 'rewardManager',
    label: 'Reward manager',
    description: 'Enable boost rewards and set the boost thank-you channel',
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
};

function defaultPermissions() {
  return {
    donations: [],
    serverPower: [],
    rewardManager: [],
    creditManager: [],
    gamerscoreManager: [],
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
  canManageDonations,
  canManageServerPower,
  canManageRewards,
  canManageCredits,
  canManageGamerscore,
  formatAreaRoles,
};

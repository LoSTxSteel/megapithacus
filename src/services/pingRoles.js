const { updateGuild, getGuild } = require('./storage');

const PING_EVENTS = {
  ban: {
    key: 'ban',
    label: 'Bans',
    description: 'Pinged when a player is banned',
  },
  unban: {
    key: 'unban',
    label: 'Unbans',
    description: 'Pinged when a player is unbanned',
  },
  kick: {
    key: 'kick',
    label: 'Kicks',
    description: 'Pinged when a player is kicked',
  },
  reminder: {
    key: 'reminder',
    label: 'Ban reminders',
    description: 'Pinged for ban ending / expired notices',
  },
};

function defaultPingRoles() {
  return {
    ban: [],
    unban: [],
    kick: [],
    reminder: [],
  };
}

function getPingRoleIds(guild, eventKey) {
  const roles = { ...defaultPingRoles(), ...(guild?.pingRoles || {}) };
  return Array.isArray(roles[eventKey]) ? roles[eventKey] : [];
}

function formatRoleMentions(roleIds) {
  if (!roleIds?.length) return '';
  return roleIds.map((id) => `<@&${id}>`).join(' ');
}

/**
 * Build message content that pings configured roles for an event.
 */
function formatPingContent(guild, eventKey, fallback = null) {
  const mentions = formatRoleMentions(getPingRoleIds(guild, eventKey));
  if (mentions && fallback) return `${mentions}\n${fallback}`;
  return mentions || fallback || null;
}

function setPingRoles(guildId, eventKey, roleIds) {
  if (!PING_EVENTS[eventKey]) {
    return { ok: false, error: 'Unknown ping event.' };
  }

  const guild = getGuild(guildId);
  const unique = [...new Set((roleIds || []).map(String))].slice(0, 10);
  const pingRoles = {
    ...defaultPingRoles(),
    ...(guild.pingRoles || {}),
    [eventKey]: unique,
  };
  updateGuild(guildId, { pingRoles });
  return { ok: true, pingRoles, roles: unique };
}

function clearPingRoles(guildId, eventKey) {
  return setPingRoles(guildId, eventKey, []);
}

function pingRolesSummary(guild) {
  return Object.values(PING_EVENTS)
    .map((ev) => {
      const ids = getPingRoleIds(guild, ev.key);
      const value = ids.length
        ? ids.map((id) => `<@&${id}>`).join(', ')
        : '_None_';
      return { name: ev.label, value, inline: false };
    });
}

module.exports = {
  PING_EVENTS,
  defaultPingRoles,
  getPingRoleIds,
  formatRoleMentions,
  formatPingContent,
  setPingRoles,
  clearPingRoles,
  pingRolesSummary,
};

/**
 * In-memory invite use cache for attributing guild joins to inviters.
 * Requires GatewayIntentBits.GuildInvites and Manage Guild / view invites.
 */

/** @type {Map<string, Map<string, { uses: number, inviterId: string|null }>>} */
const guildInviteCache = new Map();

function snapshotInvites(invites) {
  const map = new Map();
  for (const invite of invites.values()) {
    map.set(invite.code, {
      uses: Number(invite.uses) || 0,
      inviterId: invite.inviter?.id ? String(invite.inviter.id) : null,
    });
  }
  return map;
}

async function cacheGuildInvites(guild) {
  if (!guild?.id) return null;
  try {
    const invites = await guild.invites.fetch();
    const snap = snapshotInvites(invites);
    try {
      const vanity = await guild.fetchVanityData();
      if (vanity?.code) {
        snap.set(vanity.code, {
          uses: Number(vanity.uses) || 0,
          inviterId: null,
        });
      }
    } catch {
      // Vanity not available / no permission
    }
    guildInviteCache.set(String(guild.id), snap);
    return snap;
  } catch (error) {
    console.warn(
      `inviteCache: failed to cache invites for ${guild.id}:`,
      error.message
    );
    return null;
  }
}

async function cacheAllGuildInvites(client) {
  let ok = 0;
  for (const guild of client.guilds.cache.values()) {
    const snap = await cacheGuildInvites(guild);
    if (snap) ok += 1;
  }
  console.log(`inviteCache: cached invites for ${ok}/${client.guilds.cache.size} guild(s)`);
}

/**
 * Compare cached uses vs fresh fetch to find which invite was used.
 * Updates the cache afterward.
 * @returns {{ inviterId: string|null, code: string|null, vanity: boolean }}
 */
async function resolveInviter(member) {
  const guild = member.guild;
  const guildId = String(guild.id);
  const previous = guildInviteCache.get(guildId) || new Map();

  let current;
  try {
    current = snapshotInvites(await guild.invites.fetch());
  } catch (error) {
    console.warn(`inviteCache: fetch failed on join for ${guildId}:`, error.message);
    return { inviterId: null, code: null, vanity: false };
  }

  let vanityUses = null;
  let vanityCode = null;
  try {
    const vanity = await guild.fetchVanityData();
    if (vanity?.code) {
      vanityCode = vanity.code;
      vanityUses = Number(vanity.uses) || 0;
      current.set(vanity.code, { uses: vanityUses, inviterId: null });
    }
  } catch {
    // ignore
  }

  let usedCode = null;
  let inviterId = null;
  let vanity = false;

  for (const [code, entry] of current) {
    const prev = previous.get(code);
    const prevUses = prev ? prev.uses : 0;
    if (entry.uses > prevUses) {
      usedCode = code;
      inviterId = entry.inviterId;
      vanity = Boolean(vanityCode && code === vanityCode);
      break;
    }
  }

  // New invite created and used before we cached it
  if (!usedCode) {
    for (const [code, entry] of current) {
      if (!previous.has(code) && entry.uses > 0) {
        usedCode = code;
        inviterId = entry.inviterId;
        vanity = Boolean(vanityCode && code === vanityCode);
        break;
      }
    }
  }

  guildInviteCache.set(guildId, current);

  if (vanity || !inviterId) {
    return { inviterId: null, code: usedCode, vanity: vanity || !inviterId };
  }

  return { inviterId: String(inviterId), code: usedCode, vanity: false };
}

function rememberInvite(guildId, invite) {
  if (!guildId || !invite?.code) return;
  const id = String(guildId);
  const map = guildInviteCache.get(id) || new Map();
  map.set(invite.code, {
    uses: Number(invite.uses) || 0,
    inviterId: invite.inviter?.id ? String(invite.inviter.id) : null,
  });
  guildInviteCache.set(id, map);
}

function forgetInvite(guildId, code) {
  if (!guildId || !code) return;
  const map = guildInviteCache.get(String(guildId));
  if (!map) return;
  map.delete(code);
}

module.exports = {
  cacheGuildInvites,
  cacheAllGuildInvites,
  resolveInviter,
  rememberInvite,
  forgetInvite,
};

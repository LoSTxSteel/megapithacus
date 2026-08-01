const DM_DELETE_AFTER_MS = 5 * 60 * 1000;

/** Message IDs that must not auto-delete (e.g. announcements) */
const persistentDmIds = new Set();

function markDmPersistent(messageOrId) {
  const id = typeof messageOrId === 'string' ? messageOrId : messageOrId?.id;
  if (id) persistentDmIds.add(id);
}

function isDmPersistent(message) {
  if (!message) return false;
  if (persistentDmIds.has(message.id)) return true;
  const footer = message.embeds?.[0]?.footer?.text || '';
  const title = message.embeds?.[0]?.title || '';
  return /Announce/i.test(footer) || /^Announcement:/i.test(title);
}

/**
 * Delete a bot DM message after a delay (default 5 minutes).
 * Skips announcement / marked persistent DMs.
 */
function scheduleDmDelete(message, delayMs = DM_DELETE_AFTER_MS) {
  if (!message || typeof message.delete !== 'function') return;
  if (message.guildId) return;
  if (isDmPersistent(message)) return;

  setTimeout(() => {
    if (isDmPersistent(message)) return;
    message.delete().catch(() => {
      // already deleted / missing permissions
    });
  }, delayMs);
}

module.exports = {
  DM_DELETE_AFTER_MS,
  scheduleDmDelete,
  markDmPersistent,
  isDmPersistent,
};

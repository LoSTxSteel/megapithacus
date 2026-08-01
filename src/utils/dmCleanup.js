const DM_DELETE_AFTER_MS = 5 * 60 * 1000;

/**
 * Delete a bot DM message after a delay (default 5 minutes).
 */
function scheduleDmDelete(message, delayMs = DM_DELETE_AFTER_MS) {
  if (!message || typeof message.delete !== 'function') return;

  // Only auto-clean direct messages
  if (message.guildId) return;

  setTimeout(() => {
    message.delete().catch(() => {
      // already deleted / missing permissions
    });
  }, delayMs);
}

module.exports = { DM_DELETE_AFTER_MS, scheduleDmDelete };

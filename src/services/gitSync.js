/**
 * Shared helpers for hosted Git sync (root index.js owns the boot-time sync).
 */
function hostedContainer() {
  if (process.env.MEGAPITHACUS_GIT_SYNC === '1') return true;
  if (process.env.MEGAPITHACUS_GIT_SYNC === '0') return false;
  if (process.env.P_SERVER_UUID) return true;
  const dir = __dirname.replace(/\\/g, '/');
  return dir.startsWith('/home/container');
}

module.exports = { hostedContainer };

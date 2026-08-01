const fs = require('fs');
const path = require('path');

/**
 * Find the bot root (folder with commands/ or boot.js / package.json).
 * Safe on Cybrancee flat layout and local src/ layout.
 */
function projectRootFrom(startDir) {
  if (process.env.DATA_DIR) {
    return path.dirname(process.env.DATA_DIR);
  }

  let dir = path.resolve(startDir);
  for (let i = 0; i < 6; i += 1) {
    const hasCommands = fs.existsSync(path.join(dir, 'commands'));
    const hasBoot = fs.existsSync(path.join(dir, 'boot.js'));
    const hasPkg = fs.existsSync(path.join(dir, 'package.json'));
    const hasIndex =
      fs.existsSync(path.join(dir, 'index.js')) ||
      fs.existsSync(path.join(dir, 'config.js'));

    if (hasCommands || hasBoot || (hasPkg && hasIndex)) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Last resort: cwd (bootstrap chdirs to app root) or one level up from services/
  if (process.cwd() && process.cwd() !== '/') {
    return process.cwd();
  }
  return path.basename(startDir) === 'services'
    ? path.dirname(startDir)
    : path.join(startDir, '..');
}

function dataDirFrom(moduleDir) {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  return path.join(projectRootFrom(moduleDir), 'data');
}

module.exports = { projectRootFrom, dataDirFrom };

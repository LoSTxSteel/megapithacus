const fs = require('fs');
const path = require('path');
const { dataDirFrom } = require('../utils/paths');

const DATA_DIR = dataDirFrom(__dirname);
const FILE = path.join(DATA_DIR, 'announce-subscribers.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readAll() {
  try {
    if (!fs.existsSync(FILE)) return { users: {} };
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { users: data.users || {} };
  } catch {
    return { users: {} };
  }
}

function writeAll(data) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function addSubscriber(userId, guildId = null) {
  const id = String(userId);
  const all = readAll();
  all.users[id] = {
    at: new Date().toISOString(),
    guildId: guildId ? String(guildId) : all.users[id]?.guildId || null,
  };
  writeAll(all);
  return all.users[id];
}

function removeSubscriber(userId) {
  const all = readAll();
  delete all.users[String(userId)];
  writeAll(all);
}

function listSubscriberIds() {
  return Object.keys(readAll().users);
}

function subscriberCount() {
  return listSubscriberIds().length;
}

function isSubscriber(userId) {
  return Boolean(readAll().users[String(userId)]);
}

module.exports = {
  addSubscriber,
  removeSubscriber,
  listSubscriberIds,
  subscriberCount,
  isSubscriber,
};

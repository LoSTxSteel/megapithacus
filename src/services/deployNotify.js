const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const { developerGuildId, developerChannelId, brand } = require('../config');
const { brandEmbed } = require('../utils/embeds');

function resolveRootDir() {
  if (process.env.DATA_DIR) return path.dirname(process.env.DATA_DIR);
  // Local: src/services → repo root. Cybrancee flat: services → app root.
  const up1 = path.join(__dirname, '..');
  const up2 = path.join(__dirname, '..', '..');
  if (fs.existsSync(path.join(up1, 'package.json'))) return up1;
  if (fs.existsSync(path.join(up2, 'package.json'))) return up2;
  return up2;
}

const ROOT_DIR = resolveRootDir();
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
const STATE_FILE = path.join(DATA_DIR, 'deploy-notify.json');

function readPackageVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')
    );
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readPackVersion() {
  if (process.env.PACK_VERSION) return String(process.env.PACK_VERSION).trim();
  try {
    const file = path.join(ROOT_DIR, 'PACK_VERSION');
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Stable identity for "this deploy". Prefer commit SHA, then Cybrancee
 * PACK_VERSION, then package.json version.
 */
function resolveDeployIdentity() {
  const version = readPackageVersion();
  const shaRaw =
    process.env.GITHUB_SHA ||
    process.env.DEPLOY_SHA ||
    process.env.GIT_COMMIT ||
    null;
  const sha = shaRaw ? String(shaRaw).trim() : null;
  const pack = readPackVersion();

  let id;
  if (sha) id = `sha:${sha}`;
  else if (pack) id = `pack:${pack}`;
  else id = `pkg:${version}`;

  return {
    id,
    version,
    sha: sha ? (sha.length > 12 ? sha.slice(0, 7) : sha) : null,
    shaFull: sha,
    pack,
  };
}

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function buildEmbed(identity, client) {
  const lines = [
    `**${brand.name}** is online with a new deploy.`,
    '',
    `Logged in as \`${client.user.tag}\`.`,
  ];

  const embed = brandEmbed(
    new EmbedBuilder()
      .setTitle(`${brand.name} updated`)
      .setDescription(lines.join('\n')),
    null,
    { accent: true, context: 'Deploy' }
  );

  embed.addFields(
    { name: 'Version', value: identity.version, inline: true },
    {
      name: 'Deploy id',
      value: `\`${identity.id.length > 40 ? `${identity.id.slice(0, 37)}...` : identity.id}\``,
      inline: true,
    }
  );

  if (identity.sha) {
    embed.addFields({
      name: 'Commit',
      value: `\`${identity.sha}\``,
      inline: true,
    });
  }
  if (identity.pack) {
    embed.addFields({
      name: 'Pack',
      value: `\`${identity.pack}\``,
      inline: true,
    });
  }

  return embed;
}

/**
 * Post once per new deploy identity to the developer Discord channel.
 * No-ops when channel env is unset or this identity was already notified.
 */
async function notifyDeployIfNeeded(client) {
  const channelId = developerChannelId;
  if (!channelId) return;

  const identity = resolveDeployIdentity();
  const state = readState();
  if (state.lastNotifiedId === identity.id) {
    console.log(`Deploy notify: already notified for ${identity.id}`);
    return;
  }

  try {
    if (developerGuildId) {
      await client.guilds.fetch(developerGuildId).catch(() => null);
    }

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || typeof channel.send !== 'function') {
      console.warn(
        `Deploy notify: channel ${channelId} not found or not sendable`
      );
      return;
    }

    if (
      developerGuildId &&
      channel.guildId &&
      channel.guildId !== developerGuildId
    ) {
      console.warn(
        `Deploy notify: channel ${channelId} is not in DEVELOPER_GUILD_ID`
      );
      return;
    }

    await channel.send({ embeds: [buildEmbed(identity, client)] });
    writeState({
      lastNotifiedId: identity.id,
      lastNotifiedAt: new Date().toISOString(),
      lastVersion: identity.version,
      lastSha: identity.shaFull || null,
      lastPack: identity.pack || null,
    });
    console.log(`Deploy notify: posted update for ${identity.id}`);
  } catch (error) {
    console.warn('Deploy notify failed:', error.message);
  }
}

function startDeployNotify(client) {
  notifyDeployIfNeeded(client).catch((error) => {
    console.warn('Deploy notify failed:', error.message);
  });
}

module.exports = {
  startDeployNotify,
  notifyDeployIfNeeded,
  resolveDeployIdentity,
};

const fs = require('fs');
const path = require('path');
const { AttachmentBuilder, ChannelType } = require('discord.js');
const { developerChannelId } = require('../config');
const { setBrandIcon } = require('../utils/embeds');

const LOGO_NAME = 'megapithacus-logo.png';

function resolveLogoPath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', LOGO_NAME),
    path.join(__dirname, '..', 'assets', LOGO_NAME),
    path.join(process.cwd(), 'assets', LOGO_NAME),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const rootCandidates = [
    path.join(__dirname, '..', '..'),
    path.join(__dirname, '..'),
    process.cwd(),
  ];
  for (const root of rootCandidates) {
    if (fs.existsSync(path.join(root, 'package.json'))) {
      return path.join(root, 'data');
    }
  }
  return path.join(process.cwd(), 'data');
}

function readCachedUrl() {
  try {
    const file = path.join(resolveDataDir(), 'brand-icon.json');
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data?.url || null;
  } catch {
    return null;
  }
}

function writeCachedUrl(url) {
  try {
    const dir = resolveDataDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'brand-icon.json'),
      JSON.stringify({ url, at: new Date().toISOString() }, null, 2)
    );
  } catch (error) {
    console.warn('Could not cache brand icon URL:', error.message);
  }
}

async function resolveUploadChannel(client) {
  if (developerChannelId) {
    const ch = await client.channels.fetch(developerChannelId).catch(() => null);
    if (ch?.isTextBased?.()) return ch;
  }

  for (const guild of client.guilds.cache.values()) {
    const preferred =
      guild.systemChannel ||
      guild.publicUpdatesChannel ||
      guild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildText &&
          c.viewable &&
          c.permissionsFor(guild.members.me)?.has(['SendMessages', 'AttachFiles'])
      );
    if (preferred?.isTextBased?.()) return preferred;
  }
  return null;
}

/**
 * Prefer BRAND_ICON_URL, else upload assets/megapithacus-logo.png once to get a
 * Discord CDN URL for embed footer/author icons.
 */
async function ensureBrandLogo(client) {
  if (process.env.BRAND_ICON_URL) {
    setBrandIcon(process.env.BRAND_ICON_URL);
    return process.env.BRAND_ICON_URL;
  }

  const file = resolveLogoPath();
  if (!file) {
    const fallback = client?.user?.displayAvatarURL?.({
      size: 256,
      extension: 'png',
    });
    if (fallback) setBrandIcon(fallback);
    console.warn('Brand logo missing (assets/megapithacus-logo.png); using bot avatar.');
    return fallback || null;
  }

  const cached = readCachedUrl();
  if (cached) {
    setBrandIcon(cached);
    return cached;
  }

  const channel = await resolveUploadChannel(client);
  if (!channel) {
    const fallback = client?.user?.displayAvatarURL?.({
      size: 256,
      extension: 'png',
    });
    if (fallback) setBrandIcon(fallback);
    console.warn(
      'Brand logo: set DEVELOPER_CHANNEL_ID or BRAND_ICON_URL so the footer icon can be hosted.'
    );
    return fallback || null;
  }

  try {
    const attachment = new AttachmentBuilder(file, { name: LOGO_NAME });
    const msg = await channel.send({
      content: '**Megapithacus** brand icon (used on embed footers — safe to leave).',
      files: [attachment],
    });
    const uploaded = msg.attachments.first();
    const url = uploaded?.proxyURL || uploaded?.url || null;
    if (url) {
      setBrandIcon(url);
      writeCachedUrl(url);
      console.log('Brand logo ready for embed footers');
      return url;
    }
  } catch (error) {
    console.warn('Brand logo upload failed:', error.message);
  }

  return getCachedOrCurrent(null, client);
}

function getCachedOrCurrent(cached, client) {
  if (cached) return cached;
  const fallback = client?.user?.displayAvatarURL?.({
    size: 256,
    extension: 'png',
  });
  if (fallback) setBrandIcon(fallback);
  return fallback || null;
}

module.exports = {
  ensureBrandLogo,
  resolveLogoPath,
};

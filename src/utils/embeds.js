const { EmbedBuilder } = require('discord.js');
const { brand } = require('../config');

const FOOTER_CUSTOM_MAX = 48;

/**
 * Brand icon URL is intentionally unused on embeds (no logo on author/footer/thumbnail).
 * Kept for API compatibility with brandLogo / callers.
 */
let brandIconUrl = null;

function setBrandIcon(_url) {
  // No-op: Megapithacus logo is not attached to embeds.
  brandIconUrl = null;
}

function getBrandIcon() {
  return null;
}

function parseEmbedColor(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value & 0xffffff;
  }
  const raw = String(value).trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return null;
  return Number.parseInt(raw, 16);
}

function colorForGuild(guild) {
  const custom = parseEmbedColor(guild?.botCustom?.embedColor);
  return custom ?? brand.color;
}

function customFooterText(guild) {
  const custom = guild?.botCustom?.footerText;
  if (!custom || !String(custom).trim()) return null;
  return String(custom).trim().slice(0, FOOTER_CUSTOM_MAX);
}

/**
 * Footer always ends with the bot name watermark.
 * Optional guild custom text + feature context come first.
 */
function footerForGuild(guild, context = null) {
  const parts = [];
  const custom = customFooterText(guild);
  if (custom) parts.push(custom);
  if (context && String(context).trim()) {
    const ctx = String(context).trim();
    if (!parts.includes(ctx)) parts.push(ctx);
  }

  const body = parts.join(' · ');
  if (!body) return brand.name;
  if (body.includes(brand.name)) return body.slice(0, 2048);
  return `${body} · ${brand.name}`.slice(0, 2048);
}

function watermarkAuthor() {
  // Text-only author — no brand logo iconURL
  return { name: brand.name };
}

/**
 * Apply Megapithacus branding to any embed:
 * brand colour, watermark text, timestamp — no logo icons/thumbnails.
 *
 * Options:
 * - color: override embed accent (number or #hex)
 * - author: false to omit the brand author line
 * - footer: string or { text } to replace default footer text
 * - timestamp: false | Date | number (default: now)
 * - context: footer context label
 * - thumbnail: ignored for brand logo (callers may setThumbnail themselves for user avatars)
 */
function brandEmbed(embed, guild = null, options = {}) {
  const context = options.context ?? null;

  const overrideColor = parseEmbedColor(options.color);
  embed.setColor(overrideColor ?? colorForGuild(guild));

  if (options.author !== false) {
    embed.setAuthor(watermarkAuthor());
  }

  if (options.footer != null) {
    const raw =
      typeof options.footer === 'string' ? options.footer : options.footer?.text;
    embed.setFooter({ text: String(raw ?? '').slice(0, 2048) });
  } else {
    embed.setFooter({ text: footerForGuild(guild, context) });
  }

  if (options.timestamp === false) {
    /* leave unset */
  } else if (options.timestamp instanceof Date || typeof options.timestamp === 'number') {
    embed.setTimestamp(options.timestamp);
  } else {
    embed.setTimestamp();
  }

  // Do not attach brand logo as thumbnail. Intentional user/avatar thumbnails
  // set by callers via embed.setThumbnail(...) are left untouched.

  return embed;
}

function baseEmbed(title, options = {}) {
  const embed = new EmbedBuilder();
  if (title) embed.setTitle(title);
  if (options.description) embed.setDescription(options.description);
  brandEmbed(embed, null, {
    color: options.color,
    accent: options.accent,
    context: options.context ?? null,
    timestamp: options.timestamp,
  });
  if (options.footer) {
    const text = String(options.footer);
    embed.setFooter({
      text: text.includes(brand.name) ? text : `${text} · ${brand.name}`.slice(0, 2048),
    });
  }
  return embed;
}

function guildEmbed(guild, title, options = {}) {
  const embed = new EmbedBuilder();
  if (title) embed.setTitle(title);
  if (options.description) embed.setDescription(options.description);
  return brandEmbed(embed, guild, {
    color: options.color,
    accent: options.accent,
    context: options.context ?? null,
    timestamp: options.timestamp,
  });
}

function errorEmbed(message) {
  return brandEmbed(
    new EmbedBuilder()
      .setTitle('Something went wrong')
      .setDescription(message),
    null,
    { context: 'Error' }
  );
}

function successEmbed(title, description, guild = null) {
  return brandEmbed(
    new EmbedBuilder().setTitle(title).setDescription(description),
    guild,
    { context: 'Success' }
  );
}

module.exports = {
  baseEmbed,
  guildEmbed,
  brandEmbed,
  errorEmbed,
  successEmbed,
  parseEmbedColor,
  colorForGuild,
  footerForGuild,
  watermarkAuthor,
  setBrandIcon,
  getBrandIcon,
};

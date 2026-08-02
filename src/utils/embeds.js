const { EmbedBuilder } = require('discord.js');
const { brand } = require('../config');

const FOOTER_CUSTOM_MAX = 48;

/** Bot avatar / override URL used on author + footer icons */
let brandIconUrl = process.env.BRAND_ICON_URL || null;

function setBrandIcon(url) {
  if (url && String(url).trim()) {
    brandIconUrl = String(url).trim();
  }
}

function getBrandIcon() {
  return brandIconUrl || null;
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
  const author = { name: brand.name };
  const icon = getBrandIcon();
  if (icon) author.iconURL = icon;
  return author;
}

/**
 * Apply Megapithacus branding to any embed:
 * author/footer icons, red colour, watermark, timestamp.
 */
function brandEmbed(embed, guild = null, options = {}) {
  const context = options.context ?? null;
  const icon = getBrandIcon();

  embed.setColor(colorForGuild(guild));
  embed.setAuthor(watermarkAuthor());

  const footer = { text: footerForGuild(guild, context) };
  if (icon) footer.iconURL = icon;
  embed.setFooter(footer);

  if (options.timestamp === false) {
    /* leave unset */
  } else if (options.timestamp instanceof Date || typeof options.timestamp === 'number') {
    embed.setTimestamp(options.timestamp);
  } else {
    embed.setTimestamp();
  }

  const wantThumb =
    options.thumbnail === true ||
    (options.thumbnail !== false &&
      context &&
      /^(Hub|Help|Customise|Donations|Credits|Rewards|Boost rewards|Player DB|Deploy|Feature board|Announce)/i.test(
        context
      ));
  if (wantThumb && icon && !embed.data.thumbnail) {
    embed.setThumbnail(icon);
  }

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
    thumbnail: options.thumbnail,
  });
  if (options.footer) {
    const text = String(options.footer);
    const footer = {
      text: text.includes(brand.name) ? text : `${text} · ${brand.name}`.slice(0, 2048),
    };
    const icon = getBrandIcon();
    if (icon) footer.iconURL = icon;
    embed.setFooter(footer);
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
    thumbnail: options.thumbnail,
  });
}

function errorEmbed(message) {
  return brandEmbed(
    new EmbedBuilder()
      .setTitle('Something went wrong')
      .setDescription(message),
    null,
    { context: 'Error', thumbnail: true }
  );
}

function successEmbed(title, description, guild = null) {
  return brandEmbed(
    new EmbedBuilder().setTitle(title).setDescription(description),
    guild,
    { context: 'Success', thumbnail: true }
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

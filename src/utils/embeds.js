const { EmbedBuilder } = require('discord.js');
const { brand } = require('../config');

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

function footerForGuild(guild) {
  const custom = guild?.botCustom?.footerText;
  if (custom && String(custom).trim()) return String(custom).trim().slice(0, 64);
  return brand.name;
}

function baseEmbed(title, options = {}) {
  const color = options.color ?? brand.color;
  const footer = options.footer ?? brand.name;
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setFooter({ text: footer })
    .setTimestamp();
}

function guildEmbed(guild, title) {
  return baseEmbed(title, {
    color: colorForGuild(guild),
    footer: footerForGuild(guild),
  });
}

function errorEmbed(message) {
  return new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('Something went wrong')
    .setDescription(message)
    .setFooter({ text: brand.name })
    .setTimestamp();
}

function successEmbed(title, description) {
  return baseEmbed(title).setDescription(description);
}

module.exports = {
  baseEmbed,
  guildEmbed,
  errorEmbed,
  successEmbed,
  parseEmbedColor,
  colorForGuild,
  footerForGuild,
};

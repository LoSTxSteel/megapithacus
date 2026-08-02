const { MessageFlags } = require('discord.js');

/** Spread into reply / deferReply / followUp / update option objects. */
const EPHEMERAL = Object.freeze({ flags: MessageFlags.Ephemeral });

module.exports = { EPHEMERAL, MessageFlags };

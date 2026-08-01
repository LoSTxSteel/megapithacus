const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const {
  getAdminPay,
  findStaff,
  listEnabledActivities,
  validateEventRequest,
  createEventRequest,
  createPayoutRequest,
  approvePayRequest,
  denyPayRequest,
  money,
  listEnabledPaymentMethods,
  getPaymentMethod,
  formatPaymentDetails,
} = require('../services/adminPay');
const {
  BOARD_EVENT_BTN,
  BOARD_PAY_BTN,
  BOARD_PAY_METHOD_SELECT,
  BOARD_PHOTOS_SKIP,
  BOARD_PHOTOS_DONE,
  BOARD_TYPE_SELECT,
  payBoardPayload,
  requestReviewEmbed,
  requestPhotoEmbeds,
  requestReviewComponents,
} = require('../services/payBoard');
const { logPayEvent, ensurePayApprovalForum } = require('../services/payLog');
const { canManageAdminPay } = require('../services/guildPermissions');
const { errorEmbed, guildEmbed } = require('../utils/embeds');
const { scheduleDmDelete } = require('../utils/dmCleanup');
const { getGuild } = require('../services/storage');

/** userId → draft while waiting for photo upload via bot DMs */
const pendingEventDrafts = new Map();
const PHOTO_WINDOW_MS = 3 * 60 * 1000;
const MAX_EVENT_PHOTOS = 5;

function isImageAttachment(att) {
  if (att.contentType?.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(att.name || '');
}

function getPendingDraft(userId) {
  return pendingEventDrafts.get(String(userId)) || null;
}

function clearDraft(userId) {
  pendingEventDrafts.delete(String(userId));
}

async function collectRecentPhotos(channel, userId, sinceMs) {
  const photos = [];
  if (!channel?.messages) return photos;
  const messages = await channel.messages.fetch({ limit: 30 }).catch(() => null);
  if (!messages) return photos;

  const ordered = [...messages.values()].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );

  for (const message of ordered) {
    if (message.author.id !== userId) continue;
    if (message.createdTimestamp < sinceMs) continue;
    for (const att of message.attachments.values()) {
      if (!isImageAttachment(att)) continue;
      if (photos.length >= MAX_EVENT_PHOTOS) break;
      photos.push({
        url: att.url,
        name: att.name || `photo-${photos.length + 1}.png`,
      });
    }
    if (photos.length >= MAX_EVENT_PHOTOS) break;
  }
  return photos;
}

function photoStepComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(BOARD_PHOTOS_DONE)
        .setLabel('Finish with photos')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(BOARD_PHOTOS_SKIP)
        .setLabel('Skip photos')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function reviewPayload(guild, request, interaction) {
  const embed = requestReviewEmbed(guild, request, {
    requesterTag: `${interaction.user}`,
  });
  const photoEmbeds = requestPhotoEmbeds(request);
  const components = requestReviewComponents(request.id);
  const files = (request.photos || []).slice(0, MAX_EVENT_PHOTOS).map((p, i) => ({
    attachment: p.url,
    name: p.name || `event-photo-${i + 1}.png`,
  }));

  return {
    embeds: [embed, ...photoEmbeds].slice(0, 10),
    components,
    files,
  };
}

async function notifyManagers(interaction, request) {
  const guild =
    interaction.guild ||
    (await interaction.client.guilds.fetch(request.guildId).catch(() => null));
  if (!guild) {
    return { delivered: false, forum: null };
  }

  const payload = reviewPayload(guild, request, interaction);

  let delivered = false;
  let forum = null;

  try {
    forum = await ensurePayApprovalForum(guild);
    const kind = request.kind || 'event';
    const who =
      interaction.member?.displayName ||
      interaction.user.username ||
      'staff';
    const threadName = (
      kind === 'payout'
        ? `Payout · ${who}`
        : `${request.activityLabel || 'Event'} · ${who}`
    ).slice(0, 100);

    await forum.threads.create({
      name: threadName,
      message: {
        embeds: payload.embeds,
        components: payload.components,
        files: payload.files.length ? payload.files : undefined,
      },
    });
    delivered = true;
  } catch (error) {
    console.warn('Pay approval forum notify failed:', error.message);
  }

  return { delivered, forum };
}

async function finalizeEventDraft(interaction, photos) {
  const draft = getPendingDraft(interaction.user.id);
  if (!draft) {
    return { ok: false, error: 'No event draft found. Start again with **Log complete event**.' };
  }
  if (Date.now() - draft.startedAt > PHOTO_WINDOW_MS + 15_000) {
    clearDraft(interaction.user.id);
    return { ok: false, error: 'That event draft expired. Please submit again.' };
  }

  const guildId = draft.guildId;
  clearDraft(interaction.user.id);

  const result = createEventRequest(guildId, {
    userId: interaction.user.id,
    activityValue: draft.activityValue,
    hostedAt: draft.hostedAt,
    attendance: draft.attendance,
    note: draft.note,
    byTag: draft.byTag,
    photos,
  });

  if (!result.ok) return result;

  const { delivered } = await notifyManagers(interaction, result.request);

  // Refresh board in the original guild channel if we still know it
  try {
    if (draft.sourceChannelId) {
      const channel = await interaction.client.channels
        .fetch(draft.sourceChannelId)
        .catch(() => null);
      if (channel?.messages) {
        const messages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
        const board = messages?.find(
          (m) =>
            m.author.id === interaction.client.user.id &&
            m.components?.some((row) =>
              row.components?.some(
                (c) => c.customId === BOARD_EVENT_BTN || c.customId === BOARD_PAY_BTN
              )
            )
        );
        if (board) await board.edit(payBoardPayload(guildId)).catch(() => null);
      }
    }
  } catch {
    // ignore
  }

  const pay = getAdminPay(guildId);
  return {
    ok: true,
    request: result.request,
    delivered,
    pay,
    photoCount: photos.length,
    guildId,
  };
}

/**
 * Collect event proof photos sent in DMs with the bot.
 * Returns true if the message was handled.
 */
async function handleEventPhotoDm(message) {
  if (!message || message.author.bot) return false;
  if (message.guildId) return false; // guild channels — ignore
  if (!message.attachments?.size) return false;

  const draft = getPendingDraft(message.author.id);
  if (!draft) return false;
  if (Date.now() - draft.startedAt > PHOTO_WINDOW_MS) {
    clearDraft(message.author.id);
    try {
      const reply = await message.reply({
        content:
          'Your event photo upload window expired. Start again with **Log complete event** on the pay board.',
      });
      scheduleDmDelete(reply);
    } catch {
      // ignore
    }
    return true;
  }

  let added = 0;
  for (const att of message.attachments.values()) {
    if (!isImageAttachment(att)) continue;
    if (draft.photos.some((p) => p.url === att.url)) continue;
    if (draft.photos.length >= MAX_EVENT_PHOTOS) break;
    draft.photos.push({
      url: att.url,
      name: att.name || `photo-${draft.photos.length + 1}.png`,
    });
    added += 1;
  }

  if (!added) return true;

  try {
    const reply = await message.reply({
      content:
        draft.photos.length >= MAX_EVENT_PHOTOS
          ? `Got it — **${draft.photos.length}/${MAX_EVENT_PHOTOS}** photos (max reached). Press **Finish with photos**.`
          : `Got it — **${draft.photos.length}/${MAX_EVENT_PHOTOS}** photos. Send more, or press **Finish with photos**.`,
    });
    scheduleDmDelete(reply);
  } catch {
    // ignore
  }

  return true;
}

async function refreshPayBoard(interaction, guildId) {
  try {
    const channel = interaction.channel;
    if (!channel?.messages) return;
    const messages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
    const board = messages?.find(
      (m) =>
        m.author.id === interaction.client.user.id &&
        m.components?.some((row) =>
          row.components?.some(
            (c) => c.customId === BOARD_EVENT_BTN || c.customId === BOARD_PAY_BTN
          )
        )
    );
    if (board) await board.edit(payBoardPayload(guildId)).catch(() => null);
  } catch {
    // ignore
  }
}

function rosterGate(interaction, guildId) {
  const pay = getAdminPay(guildId);
  if (!findStaff(pay, interaction.user.id)) {
    return {
      ok: false,
      error:
        'You are not on the **Admin Pay** roster.\nAsk a manager to add you with `/adminpay manage`.',
    };
  }
  return { ok: true, pay };
}

async function handlePayBoardInteraction(interaction) {
  const id = interaction.customId;
  if (!id?.startsWith('payboard:') && !id?.startsWith('payreq:')) {
    return false;
  }

  const guildId = interaction.guildId;

  // —— Log complete event → event type select ——
  if (interaction.isButton() && id === BOARD_EVENT_BTN) {
    const gate = rosterGate(interaction, guildId);
    if (!gate.ok) {
      await interaction.reply({
        embeds: [errorEmbed(gate.error)],
        ephemeral: true,
      });
      return true;
    }

    const activities = listEnabledActivities(gate.pay);
    if (!activities.length) {
      await interaction.reply({
        embeds: [errorEmbed('No event types are configured.')],
        ephemeral: true,
      });
      return true;
    }

    await interaction.reply({
      embeds: [
        guildEmbed(getGuild(guildId), 'Log complete event').setDescription(
          'Choose the **event type**, then enter the date/time hosted and attendance.'
        ),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(BOARD_TYPE_SELECT)
            .setPlaceholder('Select event type')
            .addOptions(
              activities.slice(0, 25).map((a) => ({
                label: a.label.slice(0, 100),
                description: `If approved: ${money(gate.pay, a.amount)}`.slice(
                  0,
                  100
                ),
                value: a.value,
              }))
            )
        ),
      ],
      ephemeral: true,
    });
    return true;
  }

  // —— Request pay → payment method ——
  if (interaction.isButton() && id === BOARD_PAY_BTN) {
    const gate = rosterGate(interaction, guildId);
    if (!gate.ok) {
      await interaction.reply({
        embeds: [errorEmbed(gate.error)],
        ephemeral: true,
      });
      return true;
    }

    const staff = findStaff(gate.pay, interaction.user.id);
    if (staff.balance <= 0) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            `You have no owed balance to request.\nLog completed events first (current balance: **${money(
              gate.pay,
              staff.balance
            )}**).`
          ),
        ],
        ephemeral: true,
      });
      return true;
    }

    const methods = listEnabledPaymentMethods(gate.pay);
    if (!methods.length) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'No payout methods are configured.\nAsk a manager to add some in `/adminpay manage` → **Edit payout methods**.'
          ),
        ],
        ephemeral: true,
      });
      return true;
    }

    await interaction.reply({
      embeds: [
        guildEmbed(getGuild(guildId), 'Request pay').setDescription(
          [
            `Owed balance: **${money(gate.pay, staff.balance)}**`,
            '',
            'Choose how you want to be paid:',
            ...methods.map((m) => `• **${m.label}**`),
          ].join('\n')
        ),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(BOARD_PAY_METHOD_SELECT)
            .setPlaceholder('Select payment method')
            .addOptions(
              methods.slice(0, 25).map((m) => ({
                label: m.label.slice(0, 100),
                description: (m.description || m.fields?.[0]?.label || '').slice(
                  0,
                  100
                ),
                value: m.value,
              }))
            )
        ),
      ],
      ephemeral: true,
    });
    return true;
  }

  // —— Payment method chosen → details modal ——
  if (interaction.isStringSelectMenu() && id === BOARD_PAY_METHOD_SELECT) {
    const methodValue = interaction.values[0];
    const gate = rosterGate(interaction, guildId);
    if (!gate.ok) {
      await interaction.reply({
        embeds: [errorEmbed(gate.error)],
        ephemeral: true,
      });
      return true;
    }

    const method = getPaymentMethod(gate.pay, methodValue);
    if (!method || method.enabled === false) {
      await interaction.reply({
        embeds: [errorEmbed('That payout method is not available.')],
        ephemeral: true,
      });
      return true;
    }

    const staff = findStaff(gate.pay, interaction.user.id);
    const rows = [
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('amount')
          .setLabel('Amount to request')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(12)
          .setPlaceholder(
            `Leave blank for full balance (${money(gate.pay, staff.balance)})`
          )
      ),
    ];

    for (const field of (method.fields || []).slice(0, 3)) {
      const input = new TextInputBuilder()
        .setCustomId(field.id)
        .setLabel(field.label.slice(0, 45))
        .setStyle(TextInputStyle.Short)
        .setRequired(field.required !== false)
        .setMaxLength(field.maxLength || 120);
      if (field.placeholder) {
        input.setPlaceholder(field.placeholder.slice(0, 100));
      }
      rows.push(new ActionRowBuilder().addComponents(input));
    }

    // Discord modals allow max 5 rows — keep room for optional note when possible
    if (rows.length < 5) {
      rows.push(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('note')
            .setLabel('Optional notes')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(200)
        )
      );
    }

    const modal = new ModalBuilder()
      .setCustomId(`payboard:payout-modal:${method.value}`)
      .setTitle(`${method.label} details`.slice(0, 45))
      .addComponents(...rows);

    await interaction.showModal(modal);
    return true;
  }

  // —— Event type chosen → details modal ——
  if (interaction.isStringSelectMenu() && id === BOARD_TYPE_SELECT) {
    const activityValue = interaction.values[0];
    const modal = new ModalBuilder()
      .setCustomId(`payboard:event-modal:${activityValue}`)
      .setTitle('Completed event details')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('hostedAt')
            .setLabel('Date & time hosted')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100)
            .setPlaceholder('e.g. 31/07/2026 20:00 UK')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('attendance')
            .setLabel('How many attended?')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(6)
            .setPlaceholder('e.g. 12')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('note')
            .setLabel('Optional notes')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(200)
        )
      );

    await interaction.showModal(modal);
    return true;
  }

  // —— Event modal submit → photo upload step ——
  if (
    interaction.isModalSubmit() &&
    (id.startsWith('payboard:event-modal:') || id.startsWith('payboard:modal:'))
  ) {
    const activityValue = id.startsWith('payboard:event-modal:')
      ? id.slice('payboard:event-modal:'.length)
      : id.slice('payboard:modal:'.length);

    const hostedAt = interaction.fields.getTextInputValue('hostedAt');
    const attendance = interaction.fields.getTextInputValue('attendance');
    const note = interaction.fields.getTextInputValue('note');

    const checked = validateEventRequest(guildId, {
      userId: interaction.user.id,
      activityValue,
      hostedAt,
      attendance,
    });

    if (!checked.ok) {
      await interaction.reply({
        embeds: [errorEmbed(checked.error)],
        ephemeral: true,
      });
      return true;
    }

    clearDraft(interaction.user.id);
    const draft = {
      guildId,
      sourceChannelId: interaction.channelId,
      activityValue,
      hostedAt,
      attendance,
      note,
      byTag: `${interaction.user}`,
      startedAt: Date.now(),
      photos: [],
      dmChannelId: null,
    };
    pendingEventDrafts.set(String(interaction.user.id), draft);

    const photoEmbed = guildEmbed(getGuild(guildId), 'Upload event photos').setDescription(
      [
        'Send your event proof photos **in this DM** (up to ' +
          `**${MAX_EVENT_PHOTOS}** images).`,
        '',
        'Then press **Finish with photos**, or **Skip photos** to submit without proof.',
        '',
        `_You have about ${Math.round(PHOTO_WINDOW_MS / 60000)} minutes._`,
      ].join('\n')
    );

    let dmOk = false;
    try {
      const dm = await interaction.user.createDM();
      draft.dmChannelId = dm.id;
      const sent = await dm.send({
        embeds: [photoEmbed],
        components: photoStepComponents(),
      });
      scheduleDmDelete(sent);
      dmOk = true;
    } catch (error) {
      console.warn('Event photo DM failed:', error.message);
      clearDraft(interaction.user.id);
    }

    if (!dmOk) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'I could not DM you to collect photos.\n' +
              'Enable **Allow direct messages from server members** for this server, then submit the event again.'
          ),
        ],
        ephemeral: true,
      });
      return true;
    }

    await interaction.reply({
      embeds: [
        guildEmbed(getGuild(guildId), 'Check your DMs').setDescription(
          [
            'I sent you a **direct message**.',
            'Send your event photos there, then press **Finish with photos** (or **Skip photos**).',
          ].join('\n')
        ),
      ],
      ephemeral: true,
    });
    return true;
  }

  // —— Finish / skip photo step (usually in bot DMs) ——
  if (
    interaction.isButton() &&
    (id === BOARD_PHOTOS_DONE || id === BOARD_PHOTOS_SKIP)
  ) {
    const draft = getPendingDraft(interaction.user.id);
    if (!draft) {
      const msg = await interaction.reply({
        embeds: [
          errorEmbed('No event draft found. Start again with **Log complete event**.'),
        ],
        ephemeral: Boolean(interaction.guildId),
        fetchReply: true,
      });
      scheduleDmDelete(msg);
      return true;
    }

    let photos = [];
    if (id === BOARD_PHOTOS_DONE) {
      const fromCollector = [...(draft.photos || [])];
      let fromDm = [];
      if (draft.dmChannelId) {
        const dm =
          interaction.channelId === draft.dmChannelId
            ? interaction.channel
            : await interaction.client.channels
                .fetch(draft.dmChannelId)
                .catch(() => null);
        fromDm = await collectRecentPhotos(
          dm,
          interaction.user.id,
          draft.startedAt
        );
      }
      const seen = new Set();
      for (const p of [...fromCollector, ...fromDm]) {
        if (!p?.url || seen.has(p.url)) continue;
        seen.add(p.url);
        photos.push(p);
        if (photos.length >= MAX_EVENT_PHOTOS) break;
      }

      if (!photos.length) {
        const msg = await interaction.reply({
          embeds: [
            errorEmbed(
              'No photos found in our DMs yet.\n' +
                'Send image attachments here first, then press **Finish with photos** again — or press **Skip photos**.'
            ),
          ],
          ephemeral: Boolean(interaction.guildId),
          fetchReply: true,
        });
        scheduleDmDelete(msg);
        return true;
      }
    }

    await interaction.deferUpdate();
    const result = await finalizeEventDraft(interaction, photos);

    if (!result.ok) {
      const msg = await interaction.editReply({
        embeds: [errorEmbed(result.error)],
        components: [],
      });
      scheduleDmDelete(msg);
      return true;
    }

    const submittedMsg = await interaction.editReply({
      embeds: [
        guildEmbed(getGuild(result.guildId), 'Event submitted').setDescription(
          [
            `Event: **${result.request.activityLabel}**`,
            `Hosted: **${result.request.hostedAt}**`,
            `Attendance: **${result.request.attendance}**`,
            `Photos: **${result.photoCount}**`,
            `Amount if approved: **${money(result.pay, result.request.amount)}**`,
            '',
            result.delivered
              ? 'Posted to the **Admin Pay** forum for review.'
              : 'Could not post to the Admin Pay forum. Check **Manage Channels**, then run `/adminpay board` again.',
          ].join('\n')
        ),
      ],
      components: [],
    });
    scheduleDmDelete(submittedMsg);
    return true;
  }

  // —— Payout modal submit ——
  if (interaction.isModalSubmit() && id.startsWith('payboard:payout-modal')) {
    const methodValue =
      id === 'payboard:payout-modal'
        ? null
        : id.slice('payboard:payout-modal:'.length);

    const pay = getAdminPay(guildId);
    const method = methodValue ? getPaymentMethod(pay, methodValue) : null;
    const paymentDetails = {};
    for (const field of method?.fields || []) {
      try {
        paymentDetails[field.id] = interaction.fields.getTextInputValue(field.id);
      } catch {
        paymentDetails[field.id] = '';
      }
    }

    let note = '';
    try {
      note = interaction.fields.getTextInputValue('note');
    } catch {
      note = '';
    }

    const result = createPayoutRequest(guildId, {
      userId: interaction.user.id,
      amount: interaction.fields.getTextInputValue('amount'),
      note,
      byTag: `${interaction.user}`,
      paymentMethod: methodValue,
      paymentDetails,
    });

    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error)],
        ephemeral: true,
      });
      return true;
    }

    const { delivered } = await notifyManagers(interaction, result.request);
    await refreshPayBoard(interaction, guildId);

    await interaction.reply({
      embeds: [
        guildEmbed(getGuild(guildId), 'Pay request submitted').setDescription(
          [
            `Amount requested: **${money(getAdminPay(guildId), result.request.amount)}**`,
            `Method: **${result.request.paymentMethodLabel}**`,
            ...formatPaymentDetails(result.request),
            '',
            delivered
              ? 'Posted to the **Admin Pay** forum for review.'
              : 'Could not post to the Admin Pay forum. Check bot permissions.',
          ].join('\n')
        ),
      ],
      ephemeral: true,
    });
    return true;
  }

  // —— Manager approve / deny (forum thread or DM) ——
  if (interaction.isButton() && id.startsWith('payreq:')) {
    const [, action, requestId] = id.split(':');
    if (!requestId || !['approve', 'deny'].includes(action)) return true;

    let targetGuildId = interaction.guildId;
    if (!targetGuildId) {
      const { listGuildIds } = require('../services/storage');
      for (const gid of listGuildIds()) {
        const req = getAdminPay(gid).requests.find((r) => r.id === requestId);
        if (req) {
          targetGuildId = gid;
          break;
        }
      }
    }

    if (!targetGuildId) {
      await interaction.reply({
        embeds: [errorEmbed('Could not find that request.')],
        ephemeral: true,
      });
      return true;
    }

    const guild = await interaction.client.guilds.fetch(targetGuildId).catch(() => null);
    if (!guild) {
      await interaction.reply({
        embeds: [errorEmbed('Could not find that Discord server.')],
        ephemeral: true,
      });
      return true;
    }

    // In DMs, only the server owner can review; in-guild, Admin Pay managers can
    let allowed = false;
    if (interaction.guildId) {
      allowed = canManageAdminPay(interaction);
    } else {
      allowed = guild.ownerId === interaction.user.id;
    }

    if (!allowed) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'Only the **server owner** or members with **Admin Pay** access can approve or deny.'
          ),
        ],
        ephemeral: true,
      });
      return true;
    }

    const kindLabel = (req) =>
      (req.kind || 'event') === 'payout' ? 'Pay request' : 'Completed event';

    if (action === 'approve') {
      const result = approvePayRequest(targetGuildId, requestId, {
        reviewerId: interaction.user.id,
        reviewerTag: `${interaction.user}`,
      });
      if (!result.ok) {
        await interaction.reply({
          embeds: [errorEmbed(result.error)],
          ephemeral: true,
        });
        return true;
      }

      try {
        await logPayEvent(guild, result.entry);
      } catch (error) {
        console.warn('Approved pay log failed:', error.message);
      }

      const pay = getAdminPay(targetGuildId);
      const isPayout = (result.request.kind || 'event') === 'payout';

      try {
        const requester = await interaction.client.users.fetch(result.request.userId);
        const dmMsg = await requester.send({
          embeds: [
            guildEmbed(
              getGuild(targetGuildId),
              `${kindLabel(result.request)} approved`
            ).setDescription(
              isPayout
                ? [
                    `Your pay request was approved.`,
                    `Paid: **${money(pay, result.amount)}**`,
                    `Remaining balance: **${money(pay, result.balance)}**`,
                  ].join('\n')
                : [
                    `Your **${result.request.activityLabel}** event was approved.`,
                    `Credited: **${money(pay, result.amount)}**`,
                    `Balance owed: **${money(pay, result.balance)}**`,
                  ].join('\n')
            ),
          ],
        });
        scheduleDmDelete(dmMsg);
      } catch {
        // requester DMs closed
      }

      await interaction.update({
        content: `Approved by <@${interaction.user.id}>`,
        embeds: [
          guildEmbed(
            getGuild(targetGuildId),
            `${kindLabel(result.request)} approved`
          ).setDescription(
            isPayout
              ? [
                  `<@${result.request.userId}> · payout **${money(pay, result.amount)}**`,
                  `Remaining balance **${money(pay, result.balance)}**`,
                ].join('\n')
              : [
                  `<@${result.request.userId}> · **${result.request.activityLabel}**`,
                  `Credited **${money(pay, result.amount)}** · balance **${money(
                    pay,
                    result.balance
                  )}**`,
                  `Hosted: ${result.request.hostedAt} · Attendance: ${result.request.attendance}`,
                ].join('\n')
          ),
        ],
        components: [],
      });
      return true;
    }

    if (action === 'deny') {
      const result = denyPayRequest(targetGuildId, requestId, {
        reviewerId: interaction.user.id,
        reviewerTag: `${interaction.user}`,
      });
      if (!result.ok) {
        await interaction.reply({
          embeds: [errorEmbed(result.error)],
          ephemeral: true,
        });
        return true;
      }

      try {
        const requester = await interaction.client.users.fetch(result.request.userId);
        const dmMsg = await requester.send({
          embeds: [
            guildEmbed(
              getGuild(targetGuildId),
              `${kindLabel(result.request)} denied`
            ).setDescription(
              (result.request.kind || 'event') === 'payout'
                ? 'Your pay request was denied by a manager.'
                : `Your **${result.request.activityLabel}** event (${result.request.hostedAt}) was denied by a manager.`
            ),
          ],
        });
        scheduleDmDelete(dmMsg);
      } catch {
        // ignore
      }

      await interaction.update({
        content: `Denied by <@${interaction.user.id}>`,
        embeds: [
          guildEmbed(
            getGuild(targetGuildId),
            `${kindLabel(result.request)} denied`
          ).setDescription(
            (result.request.kind || 'event') === 'payout'
              ? `<@${result.request.userId}> · payout **${money(
                  getAdminPay(targetGuildId),
                  result.request.amount
                )}**`
              : [
                  `<@${result.request.userId}> · **${result.request.activityLabel}**`,
                  `Hosted: ${result.request.hostedAt} · Attendance: ${result.request.attendance}`,
                ].join('\n')
          ),
        ],
        components: [],
      });
      return true;
    }
  }

  return false;
}

module.exports = { handlePayBoardInteraction, handleEventPhotoDm };

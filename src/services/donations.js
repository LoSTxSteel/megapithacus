const { getGuild, updateGuild } = require('./storage');

function defaultPayPalConfig() {
  return {
    enabled: false,
    clientId: null,
    clientSecret: null,
    mode: 'live',
    lastSyncAt: null,
  };
}

function defaultStripeConfig() {
  return {
    enabled: false,
    secretKey: null,
    lastSyncAt: null,
  };
}

function defaultDonations() {
  return {
    currency: 'GBP',
    currencySymbol: '£',
    methods: [],
    records: [],
    statsHistory: [],
    paypal: defaultPayPalConfig(),
    stripe: defaultStripeConfig(),
  };
}

function getDonationCurrency(guildId) {
  const guild = getGuild(guildId);
  const raw = guild.donations || {};
  return {
    currency: raw.currency || 'GBP',
    currencySymbol: raw.currencySymbol || '£',
  };
}

function getDonations(guildId) {
  const guild = getGuild(guildId);
  const raw = guild.donations || {};
  const currency = getDonationCurrency(guildId);
  return {
    currency: currency.currency,
    currencySymbol: currency.currencySymbol,
    methods: [...(raw.methods || [])],
    records: [...(raw.records || [])],
    statsHistory: [...(raw.statsHistory || [])],
    paypal: {
      ...defaultPayPalConfig(),
      ...(raw.paypal || {}),
    },
    stripe: {
      ...defaultStripeConfig(),
      ...(raw.stripe || {}),
    },
  };
}

function getPayPalConfig(guildId) {
  return getDonations(guildId).paypal;
}

function updatePayPalConfig(guildId, patch) {
  const donations = getDonations(guildId);
  donations.paypal = {
    ...defaultPayPalConfig(),
    ...donations.paypal,
    ...patch,
  };
  saveDonations(guildId, donations);
  return getPayPalConfig(guildId);
}

function paypalConfiguredSummary(guildId) {
  const paypal = getPayPalConfig(guildId);
  const hasCreds = Boolean(
    (paypal.clientId && paypal.clientSecret) ||
      (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET)
  );
  if (!paypal.enabled) {
    return hasCreds
      ? 'PayPal sync: **off** (credentials saved)'
      : 'PayPal sync: **off** — configure API credentials to auto-confirm received money';
  }
  if (!hasCreds) {
    return 'PayPal sync: **on** but missing Client ID / Secret';
  }
  return `PayPal sync: **on** (${paypal.mode || 'live'}) — checks the main account every 5 minutes`;
}

function getStripeConfig(guildId) {
  return getDonations(guildId).stripe;
}

function updateStripeConfig(guildId, patch) {
  const donations = getDonations(guildId);
  donations.stripe = {
    ...defaultStripeConfig(),
    ...donations.stripe,
    ...patch,
  };
  saveDonations(guildId, donations);
  return getStripeConfig(guildId);
}

function stripeConfiguredSummary(guildId) {
  const stripe = getStripeConfig(guildId);
  const hasCreds = Boolean(
    stripe.secretKey || process.env.STRIPE_SECRET_KEY
  );
  if (!stripe.enabled) {
    return hasCreds
      ? 'Stripe sync: **off** (secret key saved)'
      : 'Stripe sync: **off** — configure a secret key to auto-confirm payments';
  }
  if (!hasCreds) {
    return 'Stripe sync: **on** but missing secret key';
  }
  const mode = String(stripe.secretKey || process.env.STRIPE_SECRET_KEY || '').startsWith(
    'sk_test_'
  )
    ? 'test'
    : 'live';
  return `Stripe sync: **on** (${mode}) — checks succeeded PaymentIntents every 5 minutes`;
}

function findByStripePaymentId(guildId, paymentIntentId) {
  if (!paymentIntentId) return null;
  return (
    getDonations(guildId).records.find(
      (r) => r.stripePaymentIntentId === paymentIntentId
    ) || null
  );
}

/**
 * Auto-create a confirmed donation from a succeeded Stripe PaymentIntent.
 */
function createDonationFromStripe(guildId, { payment, donorId }) {
  if (!payment?.paymentIntentId) {
    return { ok: false, error: 'Missing Stripe payment intent id.' };
  }
  if (findByStripePaymentId(guildId, payment.paymentIntentId)) {
    return { ok: false, error: 'Payment already logged.' };
  }

  const amount = Number(payment.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Invalid Stripe amount.' };
  }

  const donations = getDonations(guildId);
  const stripeMethod =
    listEnabledMethods(donations).find((m) => /stripe/i.test(m.label)) || null;

  const now = new Date().toISOString();
  const payerLabel =
    payment.receiptEmail ||
    payment.description ||
    'Stripe donor';

  const record = {
    id: newId(),
    guildId,
    donorId: donorId ? String(donorId) : null,
    donorTag: payerLabel,
    methodId: stripeMethod?.id || 'stripe',
    methodLabel: stripeMethod?.label || 'Stripe',
    methodLink: stripeMethod?.link || null,
    amount: Math.round(amount * 100) / 100,
    note: payment.note || null,
    status: 'received',
    confirmed: true,
    createdAt: payment.createdAt || now,
    createdById: 'stripe',
    createdByTag: 'Stripe sync',
    receivedAt: payment.createdAt || now,
    receivedById: 'stripe',
    receivedByTag: 'Stripe (auto-confirmed)',
    deliveredAt: null,
    deliveredById: null,
    deliveredByTag: null,
    logThreadId: null,
    logMessageId: null,
    stripePaymentIntentId: payment.paymentIntentId,
    stripeReceiptEmail: payment.receiptEmail || null,
    stripeCurrency: payment.currency || null,
  };

  donations.records = [record, ...(donations.records || [])].slice(0, 500);
  saveDonations(guildId, donations);
  return { ok: true, record: getDonation(guildId, record.id) };
}

function parseDiscordIdFromText(text) {
  if (!text) return null;
  const mention = String(text).match(/<@!?(\d{17,20})>/);
  if (mention) return mention[1];
  const bare = String(text).match(/\b(\d{17,20})\b/);
  return bare ? bare[1] : null;
}

function findByPayPalTransactionId(guildId, transactionId) {
  if (!transactionId) return null;
  return (
    getDonations(guildId).records.find(
      (r) => r.paypalTransactionId === transactionId
    ) || null
  );
}

/**
 * Auto-create a confirmed donation from a PayPal credit on the main account.
 */
function createDonationFromPayPal(guildId, { transaction, donorId }) {
  if (!transaction?.transactionId) {
    return { ok: false, error: 'Missing PayPal transaction id.' };
  }
  if (findByPayPalTransactionId(guildId, transaction.transactionId)) {
    return { ok: false, error: 'Transaction already logged.' };
  }

  const amount = Number(transaction.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Invalid PayPal amount.' };
  }

  const donations = getDonations(guildId);
  const paypalMethod =
    listEnabledMethods(donations).find((m) =>
      /paypal/i.test(m.label)
    ) || null;

  const now = new Date().toISOString();
  const payerLabel =
    transaction.payerName ||
    transaction.payerEmail ||
    'PayPal donor';

  const record = {
    id: newId(),
    guildId,
    donorId: donorId ? String(donorId) : null,
    donorTag: payerLabel,
    methodId: paypalMethod?.id || 'paypal',
    methodLabel: paypalMethod?.label || 'PayPal',
    methodLink: paypalMethod?.link || null,
    amount: Math.round(amount * 100) / 100,
    note: transaction.note || null,
    status: 'received',
    confirmed: true,
    createdAt: transaction.updatedAt || now,
    createdById: 'paypal',
    createdByTag: 'PayPal sync',
    receivedAt: transaction.updatedAt || now,
    receivedById: 'paypal',
    receivedByTag: 'PayPal (auto-confirmed)',
    deliveredAt: null,
    deliveredById: null,
    deliveredByTag: null,
    logThreadId: null,
    logMessageId: null,
    paypalTransactionId: transaction.transactionId,
    paypalPayerEmail: transaction.payerEmail || null,
    paypalPayerName: transaction.payerName || null,
    paypalCurrency: transaction.currency || null,
  };

  donations.records = [record, ...(donations.records || [])].slice(0, 500);
  saveDonations(guildId, donations);
  return { ok: true, record: getDonation(guildId, record.id) };
}

function saveDonations(guildId, donations) {
  updateGuild(guildId, { donations });
  return getDonations(guildId);
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function slugify(label) {
  return (
    String(label || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || `method_${Date.now().toString(36)}`
  );
}

function listMethods(donations) {
  return [...(donations.methods || [])];
}

function listEnabledMethods(donations) {
  return listMethods(donations).filter((m) => m.enabled !== false);
}

function getMethod(donations, methodId) {
  return listMethods(donations).find((m) => m.id === methodId) || null;
}

function methodSummaryLines(donations) {
  const list = listEnabledMethods(donations);
  if (!list.length) return ['_No donation methods configured._'];
  return list.map((m) => {
    const link = m.link ? ` — [link](${m.link})` : '';
    return `• **${m.label}**${link}${m.description ? `\n  ${m.description}` : ''}`;
  });
}

function addMethod(guildId, { label, link, description }) {
  const donations = getDonations(guildId);
  const name = String(label || '').trim();
  if (name.length < 2) {
    return { ok: false, error: 'Enter a method name (at least 2 characters).' };
  }

  const url = String(link || '').trim();
  if (!url || !/^https?:\/\/.+/i.test(url)) {
    return {
      ok: false,
      error: 'Enter a valid donation link starting with `http://` or `https://`.',
    };
  }

  if (donations.methods.length >= 25) {
    return { ok: false, error: 'You can have at most **25** donation methods.' };
  }

  let id = slugify(name);
  const existing = new Set(donations.methods.map((m) => m.id));
  if (existing.has(id)) {
    let n = 2;
    while (existing.has(`${id}_${n}`) && n < 99) n += 1;
    id = `${id}_${n}`.slice(0, 64);
  }

  const method = {
    id,
    label: name.slice(0, 100),
    link: url.slice(0, 500),
    description: description ? String(description).trim().slice(0, 200) : '',
    enabled: true,
    createdAt: new Date().toISOString(),
  };

  donations.methods.push(method);
  saveDonations(guildId, donations);
  return { ok: true, method };
}

function updateMethod(guildId, methodId, { label, link, description, enabled }) {
  const donations = getDonations(guildId);
  const method = getMethod(donations, methodId);
  if (!method) return { ok: false, error: 'Donation method not found.' };

  if (label !== undefined) {
    const name = String(label || '').trim();
    if (name.length < 2) {
      return { ok: false, error: 'Name must be at least 2 characters.' };
    }
    method.label = name.slice(0, 100);
  }

  if (link !== undefined) {
    const url = String(link || '').trim();
    if (!url || !/^https?:\/\/.+/i.test(url)) {
      return {
        ok: false,
        error: 'Enter a valid donation link starting with `http://` or `https://`.',
      };
    }
    method.link = url.slice(0, 500);
  }

  if (description !== undefined) {
    method.description = description
      ? String(description).trim().slice(0, 200)
      : '';
  }

  if (enabled !== undefined) {
    method.enabled = Boolean(enabled);
  }

  saveDonations(guildId, donations);
  return { ok: true, method: getMethod(getDonations(guildId), methodId) };
}

function removeMethod(guildId, methodId) {
  const donations = getDonations(guildId);
  const before = donations.methods.length;
  donations.methods = donations.methods.filter((m) => m.id !== methodId);
  if (donations.methods.length === before) {
    return { ok: false, error: 'Donation method not found.' };
  }
  saveDonations(guildId, donations);
  return { ok: true };
}

/**
 * Create a donation record.
 * - pending: donor claimed they donated (awaiting money confirmation)
 * - received: money confirmed → auto-confirmed + ready for delivery
 */
function createDonation(guildId, {
  donorId,
  donorTag,
  methodId,
  amount,
  note,
  byId,
  byTag,
  alreadyReceived = false,
}) {
  const donations = getDonations(guildId);
  const method = getMethod(donations, methodId);
  if (!method || method.enabled === false) {
    return { ok: false, error: 'That donation method is not available.' };
  }

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: 'Enter a donation amount greater than 0.' };
  }

  const now = new Date().toISOString();
  const record = {
    id: newId(),
    guildId,
    donorId: String(donorId),
    donorTag: donorTag || null,
    methodId: method.id,
    methodLabel: method.label,
    methodLink: method.link,
    amount: Math.round(value * 100) / 100,
    note: note ? String(note).trim().slice(0, 200) : null,
    // pending → received (money in) → delivered (reward given)
    status: alreadyReceived ? 'received' : 'pending',
    confirmed: Boolean(alreadyReceived),
    createdAt: now,
    createdById: byId || donorId,
    createdByTag: byTag || donorTag || null,
    receivedAt: alreadyReceived ? now : null,
    receivedById: alreadyReceived ? byId || null : null,
    receivedByTag: alreadyReceived ? byTag || null : null,
    deliveredAt: null,
    deliveredById: null,
    deliveredByTag: null,
    logThreadId: null,
    logMessageId: null,
  };

  donations.records = [record, ...(donations.records || [])].slice(0, 500);
  saveDonations(guildId, donations);
  return { ok: true, record: getDonation(guildId, record.id), method };
}

function getDonation(guildId, donationId) {
  return getDonations(guildId).records.find((r) => r.id === donationId) || null;
}

function updateDonation(guildId, donationId, patch) {
  const donations = getDonations(guildId);
  const idx = donations.records.findIndex((r) => r.id === donationId);
  if (idx === -1) return { ok: false, error: 'Donation not found.' };
  donations.records[idx] = { ...donations.records[idx], ...patch };
  saveDonations(guildId, donations);
  return { ok: true, record: getDonation(guildId, donationId) };
}

/** Money received → auto-confirm */
function markDonationReceived(guildId, donationId, { byId, byTag }) {
  const record = getDonation(guildId, donationId);
  if (!record) return { ok: false, error: 'Donation not found.' };
  if (record.status === 'delivered') {
    return { ok: false, error: 'This donation is already marked delivered.' };
  }
  if (record.status === 'received' && record.confirmed) {
    return { ok: false, error: 'This donation is already confirmed as received.' };
  }

  return updateDonation(guildId, donationId, {
    status: 'received',
    confirmed: true,
    receivedAt: new Date().toISOString(),
    receivedById: byId,
    receivedByTag: byTag,
  });
}

function markDonationDelivered(guildId, donationId, { byId, byTag }) {
  const record = getDonation(guildId, donationId);
  if (!record) return { ok: false, error: 'Donation not found.' };
  if (record.status === 'pending' || !record.confirmed) {
    return {
      ok: false,
      error: 'Mark the donation as **received** first (money confirmed).',
    };
  }
  if (record.status === 'delivered') {
    return { ok: false, error: 'Already marked as delivered.' };
  }

  return updateDonation(guildId, donationId, {
    status: 'delivered',
    deliveredAt: new Date().toISOString(),
    deliveredById: byId,
    deliveredByTag: byTag,
  });
}

function money(amount, symbol = '£') {
  return `${symbol}${Number(amount || 0).toFixed(2)}`;
}

module.exports = {
  defaultDonations,
  defaultPayPalConfig,
  defaultStripeConfig,
  getDonationCurrency,
  getDonations,
  getPayPalConfig,
  updatePayPalConfig,
  paypalConfiguredSummary,
  getStripeConfig,
  updateStripeConfig,
  stripeConfiguredSummary,
  parseDiscordIdFromText,
  findByPayPalTransactionId,
  createDonationFromPayPal,
  findByStripePaymentId,
  createDonationFromStripe,
  listMethods,
  listEnabledMethods,
  getMethod,
  methodSummaryLines,
  addMethod,
  updateMethod,
  removeMethod,
  createDonation,
  getDonation,
  updateDonation,
  markDonationReceived,
  markDonationDelivered,
  money,
};

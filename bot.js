// Rewritten: conservative acknowledgement, component-safe, duplicate-deletion fallback, restored handlers

const cfg = require('./config');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  PermissionsBitField,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
} = require("discord.js");
const noblox = require("noblox.js");
const fetch = require("node-fetch");
const express = require('express');

const DEBUG = !!process.env.DEBUG_SIGNATURES;

// will hold Google sheet
let sheetDoc = null;

console.log("Env present:", {
  GOOGLE_CLIENT_EMAIL: !!process.env.GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY: !!process.env.GOOGLE_PRIVATE_KEY,
  SPREADSHEET_ID: !!process.env.SPREADSHEET_ID,
  ROBLOX_COOKIE: !!process.env.ROBLOX_COOKIE,
  BOT_LOG_CHANNEL_ID: !!process.env.BOT_LOG_CHANNEL_ID,
  DEBUG
});

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// health server
const app = express();
app.get('/', (req, res) => res.status(200).send('OK'));
app.get('/health', (req, res) => res.status(200).json({ status: 'up' }));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Health server listening on :${PORT}`));

// ---------- Utilities ----------
function isComponentInteraction(interaction) {
  // select menus and buttons are component interactions; modal submit is InteractionType.ModalSubmit
  try {
    return interaction?.isStringSelectMenu?.() || interaction?.isButton?.() || (interaction?.type === InteractionType.ModalSubmit);
  } catch {
    return false;
  }
}

// ---------- Signature store ----------
const _recentSignatures = new Map();
const SIGNATURE_TTL_MS = 8000;

function signatureFromPayload(payload) {
  if (!payload) return '';
  let p = payload;
  if (typeof payload === 'string') p = { content: payload };
  const parts = [];
  if (p.content) parts.push(String(p.content).replace(/\s+/g, ' ').trim().slice(0, 400));
  if (Array.isArray(p.embeds) && p.embeds[0]) {
    const e = p.embeds[0];
    if (e.title) parts.push(String(e.title).replace(/\s+/g, ' ').trim().slice(0,200));
    if (e.description) parts.push(String(e.description).replace(/\s+/g, ' ').trim().slice(0,200));
  }
  if (Array.isArray(p.components) && p.components.length) {
    try {
      const compParts = [];
      for (const row of p.components) {
        const comps = row.components ?? row;
        if (!Array.isArray(comps)) continue;
        for (const c of comps) {
          if (!c) continue;
          if (c.customId) compParts.push(String(c.customId));
          else if (c.placeholder) compParts.push(String(c.placeholder));
          else if (Array.isArray(c.options) && c.options.length) {
            compParts.push(c.options.slice(0,5).map(o => String(o.label||o.value||'').replace(/\s+/g,' ').trim()).join(','));
          } else if (c.label) compParts.push(String(c.label));
        }
      }
      if (compParts.length) parts.push(compParts.join('|').slice(0,400));
    } catch {}
  }
  const sig = parts.join('||').slice(0,1000);
  if (DEBUG) console.log('signatureFromPayload ->', sig);
  return sig;
}

function registerSignature(sig, channelId, messageId = null, payloadSummary = null) {
  if (!sig || !channelId) return;
  _recentSignatures.set(sig, {
    channelId,
    messageId: messageId || null,
    payloadSummary: payloadSummary || null,
    expiresAt: Date.now() + SIGNATURE_TTL_MS,
  });
  if (DEBUG) console.log('registerSignature', sig, '->', _recentSignatures.get(sig));
}

async function findRegisteredMessageForSignature(sig, channelId) {
  if (!sig || !channelId) return null;
  const rec = _recentSignatures.get(sig);
  if (!rec) return null;
  if (rec.channelId !== channelId) return null;
  if (rec.expiresAt <= Date.now()) {
    _recentSignatures.delete(sig);
    return null;
  }
  if (rec.messageId) {
    try {
      const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
      if (!ch?.messages) return null;
      const m = await ch.messages.fetch(rec.messageId).catch(()=>null);
      if (m) return m;
    } catch {}
    return null;
  }
  // sentinel-only: try to find by payloadSummary among recent bot messages
  try {
    const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
    if (!ch?.messages) return null;
    const recent = await ch.messages.fetch({ limit: 50 }).catch(()=>null);
    if (!recent) return null;
    const candidates = recent.filter(m => m.author?.id === client.user?.id);
    for (const m of candidates.values()) {
      if (rec.payloadSummary && (m.content || '').includes(rec.payloadSummary)) return m;
      const e = m.embeds?.[0];
      if (e && rec.payloadSummary && ((e.title && e.title.includes(rec.payloadSummary)) || (e.description && e.description.includes(rec.payloadSummary)))) {
        return m;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// delete a previously registered message when we know the new interaction-created message succeeded
async function deleteRegisteredMessageBySig(sig, channelId, exceptMessageId = null) {
  if (!sig || !channelId) return;
  const rec = _recentSignatures.get(sig);
  if (!rec) return;
  if (rec.channelId !== channelId) return;
  if (!rec.messageId) return;
  if (rec.messageId === exceptMessageId) {
    _recentSignatures.delete(sig);
    return;
  }
  try {
    const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
    if (!ch?.messages) return;
    await ch.messages.delete(rec.messageId).catch(()=>{});
  } catch {}
  _recentSignatures.delete(sig);
}

// last-resort scan & delete messages that are similar
async function deleteOtherBotMessagesSimilar(channelId, keepMessageId, payloadSummary) {
  if (!channelId) return;
  try {
    const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
    if (!ch?.messages) return;
    const recent = await ch.messages.fetch({ limit: 50 }).catch(()=>null);
    if (!recent) return;
    const candidates = recent.filter(m => m.author?.id === client.user?.id && m.id !== keepMessageId);
    for (const m of candidates.values()) {
      if (!payloadSummary) continue;
      const e = m.embeds?.[0];
      if ((m.content || '').includes(payloadSummary) ||
          (e && ((e.title && e.title.includes(payloadSummary)) || (e.description && e.description.includes(payloadSummary))))) {
        await m.delete().catch(()=>{});
      }
    }
  } catch {}
}

// ---------- Safe send helpers ----------
const _sentOnce = new WeakMap();
const _perUserDedupe = new Map();
const PER_USER_TTL_MS = 4000;

async function sendOnce(interaction, key, contentObj) {
  if (!interaction) {
    const ch = contentObj?.channel || null;
    if (ch && typeof ch.send === 'function') return ch.send(contentObj.content ?? contentObj);
    return null;
  }
  const userId = interaction.user?.id || interaction.member?.user?.id || null;
  const perKey = userId ? `${userId}:${key}` : null;
  if (perKey) {
    const e = _perUserDedupe.get(perKey);
    if (e && e > Date.now()) {
      if (DEBUG) console.log('sendOnce blocked per-user dedupe', perKey);
      return null;
    }
  }
  let set = _sentOnce.get(interaction);
  if (!set) { set = new Set(); _sentOnce.set(interaction, set); }
  if (set.has(key)) return null;
  const sent = await safeSendAndReturnMessage(interaction, contentObj);
  if (sent !== null) {
    try { set.add(key); } catch {}
    if (perKey) _perUserDedupe.set(perKey, Date.now() + PER_USER_TTL_MS);
  }
  return sent;
}

async function safeSendAndReturnMessage(interaction, contentObj = {}) {
  let payload = contentObj;
  if (typeof contentObj === 'string') payload = { content: contentObj };

  const sig = signatureFromPayload(payload);
  const channelId = interaction?.channel?.id || interaction?.message?.channel?.id || null;

  // If a recent matching message exists, return it (do NOT ack component interactions here)
  if (sig && channelId) {
    const existing = await findRegisteredMessageForSignature(sig, channelId);
    if (existing) {
      if (DEBUG) console.log('safeSend: found existing message for signature, returning existing.');
      // Do NOT call deferReply/deferUpdate for component interactions (it may break showModal)
      try {
        if (!isComponentInteraction(interaction)) {
          if (!interaction.replied && !interaction.deferred) {
            if (typeof interaction.deferReply === 'function') await interaction.deferReply({ ephemeral: true }).catch(()=>{});
          }
        }
      } catch {}
      return existing;
    }
  }

  const makeSentinel = (path) => ({ __sentinel: true, path, channelId, content: payload?.content ?? null, embeds: payload?.embeds ?? null, timestamp: Date.now() });

  // Try reply -> fetchReply
  try {
    if (interaction && !interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply(payload);
        try {
          const msg = await interaction.fetchReply();
          if (DEBUG) console.log('safeSend: used reply -> fetched message');
          if (sig && channelId) {
            registerSignature(sig, channelId, msg.id, payload?.content?.slice(0,200) ?? null);
            await deleteRegisteredMessageBySig(sig, channelId, msg.id).catch(()=>{});
            await deleteOtherBotMessagesSimilar(channelId, msg.id, payload?.content?.slice(0,200) ?? null).catch(()=>{});
          }
          return msg;
        } catch (e) {
          if (DEBUG) console.log('safeSend: reply succeeded but fetchReply failed', e?.message);
          if (sig && channelId) registerSignature(sig, channelId, null, payload?.content?.slice(0,200) ?? null);
          return makeSentinel('reply_no_fetch');
        }
      } catch (e) {
        if (DEBUG) console.log('safeSend: interaction.reply failed', e?.message);
      }
    }

    // editReply path when already deferred/replied
    if (interaction && (interaction.deferred || interaction.replied)) {
      try {
        await interaction.editReply(payload);
        try {
          const msg = await interaction.fetchReply();
          if (DEBUG) console.log('safeSend: used editReply -> fetched message');
          if (sig && channelId) {
            registerSignature(sig, channelId, msg.id, payload?.content?.slice(0,200) ?? null);
            await deleteRegisteredMessageBySig(sig, channelId, msg.id).catch(()=>{});
            await deleteOtherBotMessagesSimilar(channelId, msg.id, payload?.content?.slice(0,200) ?? null).catch(()=>{});
          }
          return msg;
        } catch (e) {
          if (DEBUG) console.log('safeSend: editReply succeeded but fetchReply failed', e?.message);
          if (sig && channelId) registerSignature(sig, channelId, null, payload?.content?.slice(0,200) ?? null);
          return makeSentinel('edit_no_fetch');
        }
      } catch (e) {
        if (DEBUG) console.log('safeSend: interaction.editReply failed', e?.message);
      }
    }
  } catch (err) {
    if (DEBUG) console.log('safeSend: reply/edit threw', err?.message);
  }

  // followUp
  try {
    if (interaction && typeof interaction.followUp === 'function') {
      try {
        const foll = await interaction.followUp(payload);
        if (DEBUG) console.log('safeSend: used followUp');
        if (sig && channelId) {
          if (foll && foll.id) {
            registerSignature(sig, channelId, foll.id, payload?.content?.slice(0,200) ?? null);
            await deleteRegisteredMessageBySig(sig, channelId, foll.id).catch(()=>{});
            await deleteOtherBotMessagesSimilar(channelId, foll.id, payload?.content?.slice(0,200) ?? null).catch(()=>{});
          } else registerSignature(sig, channelId, null, payload?.content?.slice(0,200) ?? null);
        }
        return foll ?? makeSentinel('followup_no_message');
      } catch (e) {
        if (DEBUG) console.log('safeSend: followUp failed', e?.message);
      }
    }
  } catch (err) {
    if (DEBUG) console.log('safeSend: followUp threw', err?.message);
  }

  // Channel fallback (only used when interaction token doesn't allow reply/followUp)
  try {
    const channel = interaction?.channel || interaction?.message?.channel;
    if (channel && typeof channel.send === 'function') {
      if (sig && channel.id) {
        registerSignature(sig, channel.id, null, payload?.content?.slice(0,200) ?? null);
        if (DEBUG) console.log('safeSend: pre-registered signature before channel.send');
      }
      let sent;
      if (typeof payload === 'object') {
        const sendPayload = {};
        if (payload.content) sendPayload.content = payload.content;
        if (payload.embeds) sendPayload.embeds = payload.embeds;
        if (payload.components) sendPayload.components = payload.components;
        sent = await channel.send(sendPayload.content ?? sendPayload);
      } else {
        sent = await channel.send(payload);
      }
      if (DEBUG) console.log('safeSend: used channel.send fallback');
      if (sig && channel.id && sent?.id) registerSignature(sig, channel.id, sent.id, payload?.content?.slice(0,200) ?? null);
      return sent;
    }
  } catch (err) {
    if (DEBUG) console.log('safeSend: channel.send failed', err?.message);
  }

  return null;
}

// safe wrappers
async function safeReply(interaction, contentObj = {}) { await safeSendAndReturnMessage(interaction, contentObj); }
async function safeUpdate(interaction, updateObj = {}) {
  try {
    if (interaction && typeof interaction.update === 'function') return await interaction.update(updateObj);
    return await safeSendAndReturnMessage(interaction, updateObj);
  } catch {
    try { const ch = interaction?.channel || interaction?.message?.channel; if (ch) return ch.send(updateObj.content ?? updateObj); } catch {}
    return null;
  }
}

// ---------- Sheets helper ----------
async function getSheetOrReply(doc, title, interaction) {
  if (!doc) { try { await safeReply(interaction, { content: '❌ Google Sheets not initialized yet', ephemeral: true }); } catch {} return null; }
  const s = doc.sheetsByTitle[title];
  if (!s) { try { await safeReply(interaction, { content: `❌ Sheet "${title}" not found`, ephemeral: true }); } catch {} return null; }
  return s;
}

// ---------- deletion helpers ----------
async function safeDeleteMessage(msgOrId, channelContext = null) {
  if (!msgOrId) return;
  try {
    if (typeof msgOrId.delete === 'function') { await msgOrId.delete().catch(()=>{}); return; }
    if (msgOrId && msgOrId.__sentinel) {
      const chId = msgOrId.channelId || channelContext?.id;
      if (!chId) return;
      const ch = client.channels.cache.get(chId) || await client.channels.fetch(chId).catch(()=>null);
      if (!ch?.messages) return;
      const recent = await ch.messages.fetch({ limit: 50 }).catch(()=>null);
      if (!recent) return;
      const candidates = recent.filter(m => m.author?.id === client.user?.id);
      if (msgOrId.content) {
        const match = candidates.find(m => (m.content||'').trim() === (msgOrId.content||'').trim());
        if (match) { await match.delete().catch(()=>{}); try { _recentSignatures.delete(signatureFromPayload({ content: msgOrId.content })); } catch{}; return; }
      }
      if (msgOrId.embeds?.length) {
        for (const m of candidates.values()) {
          const e = m.embeds?.[0];
          if (!e) continue;
          if ((e.title && msgOrId.embeds[0]?.title && e.title === msgOrId.embeds[0].title) ||
              (e.description && msgOrId.embeds[0]?.description && e.description === msgOrId.embeds[0].description)) {
            await m.delete().catch(()=>{}); try { _recentSignatures.delete(signatureFromPayload({ embeds: msgOrId.embeds })); } catch{}; return;
          }
        }
      }
      return;
    }
    if (msgOrId.id && msgOrId.channel) {
      await msgOrId.channel.messages.delete(msgOrId.id).catch(()=>{}); return;
    }
    if (typeof msgOrId === 'string' && channelContext) {
      const f = await channelContext.messages.fetch(msgOrId).catch(()=>null);
      if (f) await f.delete().catch(()=>{});
      return;
    }
  } catch {}
}

// get log channel
async function getLogChannel() {
  const id = process.env.BOT_LOG_CHANNEL_ID || cfg?.logChannelId;
  if (!id) return null;
  try { return client.channels.cache.get(id) || await client.channels.fetch(id); } catch { return null; }
}

async function cleanupAndLog({ interaction, userMessages = [], botMessages = [], menuMessage = null, componentMessages = [], logText = '' }) {
  const channelContext = interaction?.channel || interaction?.message?.channel || null;
  const all = [...userMessages.filter(Boolean), ...botMessages.filter(Boolean), ...(menuMessage ? [menuMessage] : []), ...componentMessages.filter(Boolean)];
  await Promise.all(all.map(m => safeDeleteMessage(m, channelContext)));
  const logChannel = await getLogChannel();
  if (!logChannel) { console.warn('BOT_LOG_CHANNEL_ID missing; skipping log'); return; }
  try {
    const content = (logText && typeof logText === 'string') ? `<@${interaction.user.id}> — ${logText}` : `<@${interaction.user.id}> performed an action.`;
    await logChannel.send({ content }).catch((e)=>{ console.error('log send failed', e?.message); });
  } catch (e) { console.error('Failed to send log:', e); }
}

// --- Roblox cookie init (safe)
(async ()=> {
  try {
    if (process.env.ROBLOX_COOKIE) { await noblox.setCookie(process.env.ROBLOX_COOKIE); console.log('✅ Roblox cookie set'); }
    else console.warn('ROBLOX_COOKIE not set; roblox features will fail');
  } catch (err) { console.error('Roblox cookie error', err); }
})();

// Register commands
const commands = [
  new SlashCommandBuilder().setName('robloxmanager').setDescription('Roblox group management menu'),
  new SlashCommandBuilder().setName('bgc').setDescription('Background check a Roblox user').addStringOption(opt=>opt.setName('username').setDescription('Roblox username').setRequired(true)),
  new SlashCommandBuilder().setName('trackermanager').setDescription('Manage placements in your Google Tracker'),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async ()=> {
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (e) { console.error('Command registration failed', e?.message); }
})();

// ---------- Interaction handler ----------
client.on('interactionCreate', async (interaction) => {
  try {
    // NOTE: Do NOT pre-defer component interactions (selects/buttons) because showModal requires the interaction be un-deferred.
    // We will only defer for long-running chat commands where appropriate.

    // Chat commands
    if (interaction.isChatInputCommand()) {
      const isAdmin = interaction.member?.permissions?.has?.(PermissionsBitField.Flags.Administrator);
      if (!isAdmin) { await safeReply(interaction, { content: '❌ Administrator permission required.', ephemeral: true }); return; }

      if (interaction.commandName === 'robloxmanager') {
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`rc_action_${interaction.user.id}`)
            .setPlaceholder('Select an action')
            .addOptions([
              { label: 'Change Rank', value: 'change_rank' },
              { label: 'Kick User', value: 'kick_user' },
              { label: 'Accept Join Request', value: 'accept_join' },
            ])
        );
        // Use sendOnce (this will reply / followUp as needed)
        await sendOnce(interaction, 'rc_menu', { content: 'Choose an action:', components: [row] });
        return;
      }

      if (interaction.commandName === 'bgc') {
        // long running -> defer early
        try { if (!interaction.deferred && !interaction.replied) await interaction.deferReply().catch(()=>{}); } catch {}
        const username = interaction.options.getString('username');
        await sendOnce(interaction, 'bgc_fetching', { content: '🔎 Fetching Roblox data…' });
        try {
          const userRes = await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username] }) });
          const userJson = await userRes.json();
          if (!userJson.data?.length) { await sendOnce(interaction, `bgc_notfound_${username}`, { content: `❌ Could not find Roblox user **${username}**` }); return; }
          const userId = userJson.data[0].id;
          const [info, friendsJson, followersJson, followingJson, avatarJson, groupsJson] = await Promise.all([
            fetch(`https://users.roblox.com/v1/users/${userId}`).then(r=>r.json()),
            fetch(`https://friends.roblox.com/v1/users/${userId}/friends/count`).then(r=>r.json()),
            fetch(`https://friends.roblox.com/v1/users/${userId}/followers/count`).then(r=>r.json()),
            fetch(`https://friends.roblox.com/v1/users/${userId}/followings/count`).then(r=>r.json()),
            fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`).then(r=>r.json()),
            fetch(`https://groups.roblox.com/v2/users/${userId}/groups/roles`).then(r=>r.json()),
          ]);
          const avatarUrl = avatarJson.data?.[0]?.imageUrl || null;
          const groups = Array.isArray(groupsJson.data) ? groupsJson.data : [];
          const totalGroups = groups.length;
          const importantGroupIds = cfg.importantGroupIds ?? [34808935,34794384,35250103,35335293,5232591,34755744];
          const matchedKeyGroups = groups.filter(g => importantGroupIds.includes(Number(g.group.id))).map(g => `${g.group.name} — ${g.role?.name ?? 'Member'}`);
          const embed = new EmbedBuilder()
            .setTitle(`${info.name} (@${info.displayName})`)
            .setThumbnail(avatarUrl)
            .setDescription(info.description || 'No bio set.')
            .addFields(
              { name: 'Roblox ID', value: String(userId), inline: true },
              { name: 'Account Created', value: new Date(info.created).toDateString(), inline: true },
              { name: 'Friends', value: String(friendsJson.count ?? 0), inline: true },
              { name: 'Followers', value: String(followersJson.count ?? 0), inline: true },
              { name: 'Following', value: String(followingJson.count ?? 0), inline: true },
              { name: 'Total Groups', value: String(totalGroups), inline: true },
              { name: 'Key Groups', value: matchedKeyGroups.length ? matchedKeyGroups.join('\n') : 'None', inline: false },
            ).setColor(0x00ae86);
          await sendOnce(interaction, `bgc_embed_${userId}`, { embeds: [embed] });
        } catch (err) {
          console.error('bgc error', err);
          await sendOnce(interaction, 'bgc_error', { content: '❌ Error fetching data.' });
        }
        return;
      }

      if (interaction.commandName === 'trackermanager') {
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`tracker_action_${interaction.user.id}`)
            .setPlaceholder('Select a tracker action')
            .addOptions([
              { label: 'Add Placement', value: 'add_placement' },
              { label: 'Promote Placement', value: 'promote_placement' },
              { label: 'Remove User', value: 'remove_user' },
            ])
        );
        await sendOnce(interaction, 'tracker_menu', { content: 'Choose a tracker action:', components: [row] });
        return;
      }
    }

    // Component selects: DO NOT pre-defer here (showModal must be called on the original interaction)
    if (interaction.isStringSelectMenu() && (interaction.customId.startsWith('rc_action_') || interaction.customId.startsWith('tracker_action_'))) {
      const parts = interaction.customId.split('_'); const tail = parts[parts.length-1];
      if (tail !== interaction.user.id) { await safeReply(interaction, { content: '❌ This menu is not for you.', ephemeral: true }); return; }
      const value = interaction.values?.[0];
      if (!value) { await safeReply(interaction, { content: '❌ No option selected.', ephemeral: true }); return; }

      // rc menu
      if (interaction.customId.startsWith('rc_action_')) {
        if (value === 'change_rank') {
          const modal = new ModalBuilder().setCustomId(`rc_modal_changeRank_${interaction.user.id}`).setTitle('Change Rank');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('username').setLabel('Roblox username').setStyle(TextInputStyle.Short).setRequired(true)));
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rank').setLabel('Rank name or #').setStyle(TextInputStyle.Short).setRequired(true)));
          await interaction.showModal(modal).catch(e => { console.log('showModal failed', e?.message); safeReply(interaction, { content: '❌ Failed to show modal.', ephemeral: true }); });
          return;
        }
        if (value === 'kick_user') {
          const modal = new ModalBuilder().setCustomId(`rc_modal_kick_${interaction.user.id}`).setTitle('Kick User');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('username').setLabel('Roblox username').setStyle(TextInputStyle.Short).setRequired(true)));
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false)));
          await interaction.showModal(modal).catch(e => { console.log('showModal failed', e?.message); safeReply(interaction, { content: '❌ Failed to show modal.', ephemeral: true }); });
          return;
        }
        if (value === 'accept_join') {
          const modal = new ModalBuilder().setCustomId(`rc_modal_accept_${interaction.user.id}`).setTitle('Accept Join Request');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('username').setLabel('Roblox username').setStyle(TextInputStyle.Short).setRequired(true)));
          await interaction.showModal(modal).catch(e => { console.log('showModal failed', e?.message); safeReply(interaction, { content: '❌ Failed to show modal.', ephemeral: true }); });
          return;
        }
      }

      // tracker menu
      if (interaction.customId.startsWith('tracker_action_')) {
        if (value === 'add_placement') {
          const modal = new ModalBuilder().setCustomId(`tracker_modal_add_${interaction.user.id}`).setTitle('Add Placement');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('username').setLabel('Player username').setStyle(TextInputStyle.Short).setRequired(true)));
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('placement').setLabel('Placement (e.g. Recruit)').setStyle(TextInputStyle.Short).setRequired(true)));
          await interaction.showModal(modal).catch(e=>{ console.log('showModal failed', e?.message); safeReply(interaction,{ content:'❌ Failed to show modal.', ephemeral:true });});
          return;
        }
        if (value === 'promote_placement') {
          const modal = new ModalBuilder().setCustomId(`tracker_modal_promote_${interaction.user.id}`).setTitle('Promote Placement');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('username').setLabel('Player username').setStyle(TextInputStyle.Short).setRequired(true)));
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('newplacement').setLabel('New placement').setStyle(TextInputStyle.Short).setRequired(true)));
          await interaction.showModal(modal).catch(e=>{ console.log('showModal failed', e?.message); safeReply(interaction,{ content:'❌ Failed to show modal.', ephemeral:true });});
          return;
        }
        if (value === 'remove_user') {
          const modal = new ModalBuilder().setCustomId(`tracker_modal_remove_${interaction.user.id}`).setTitle('Remove from Tracker');
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('username').setLabel('Player username').setStyle(TextInputStyle.Short).setRequired(true)));
          await interaction.showModal(modal).catch(e=>{ console.log('showModal failed', e?.message); safeReply(interaction,{ content:'❌ Failed to show modal.', ephemeral:true });});
          return;
        }
      }
    }

    // modal submit handlers
    if (interaction.type === InteractionType.ModalSubmit || interaction.isModalSubmit?.()) {
      const modalId = interaction.customId;
      if (!modalId.includes(`_${interaction.user.id}`)) { await safeReply(interaction, { content: "❌ This modal isn't for you.", ephemeral: true }); return; }

      // change rank
      if (modalId.startsWith('rc_modal_changeRank_')) {
        const username = interaction.fields.getTextInputValue('username').trim();
        const rankInput = interaction.fields.getTextInputValue('rank').trim();
        await safeReply(interaction, { content: `Processing change rank for ${username}...`, ephemeral: true });
        let logText = '';
        try {
          if (!cfg.groupId) throw new Error('cfg.groupId missing');
          const userId = await noblox.getIdFromUsername(username);
          let rankNumber = parseInt(rankInput,10);
          if (isNaN(rankNumber)) {
            const roles = await noblox.getRoles(cfg.groupId);
            const match = roles.find(r => r.name.toLowerCase() === rankInput.toLowerCase());
            if (!match) throw new Error('Rank not found');
            rankNumber = match.rank;
          }
          await noblox.setRank(cfg.groupId, userId, rankNumber);
          logText = `Completed: Changed rank for ${username} to ${rankInput}`;
          await safeReply(interaction, { content: `✅ Rank changed for ${username} to ${rankInput}`, ephemeral: true });
        } catch (err) {
          console.error('changeRank err', err);
          logText = `Failed: Change rank for ${username} — ${err?.message || err}`;
          await safeReply(interaction, { content: `❌ Failed to change rank: ${err?.message || err}`, ephemeral: true });
        }
        try {
          const sig = signatureFromPayload({ content: 'Choose an action:' });
          const menuMsg = await findRegisteredMessageForSignature(sig, interaction.channelId);
          await cleanupAndLog({ interaction, menuMessage: menuMsg, logText });
        } catch {}
        return;
      }

      // kick
      if (modalId.startsWith('rc_modal_kick_')) {
        const username = interaction.fields.getTextInputValue('username').trim();
        const reason = (interaction.fields.getTextInputValue('reason') || '').trim() || 'No reason';
        await safeReply(interaction, { content: `Processing kick for ${username}...`, ephemeral: true });
        let logText = '';
        try {
          if (!cfg.groupId) throw new Error('cfg.groupId missing');
          const userId = await noblox.getIdFromUsername(username);
          await noblox.exile(cfg.groupId, userId);
          logText = `Completed: Kicked ${username} (${reason})`;
          await safeReply(interaction, { content: `✅ Kicked ${username}`, ephemeral: true });
        } catch (err) {
          console.error('kick err', err);
          logText = `Failed: Kick ${username} — ${err?.message || err}`;
          await safeReply(interaction, { content: `❌ Failed to kick: ${err?.message || err}`, ephemeral: true });
        }
        try {
          const sig = signatureFromPayload({ content: 'Choose an action:' });
          const menuMsg = await findRegisteredMessageForSignature(sig, interaction.channelId);
          await cleanupAndLog({ interaction, menuMessage: menuMsg, logText });
        } catch {}
        return;
      }

      // accept join
      if (modalId.startsWith('rc_modal_accept_')) {
        const username = interaction.fields.getTextInputValue('username').trim();
        await safeReply(interaction, { content: `Processing accept join for ${username}...`, ephemeral: true });
        let logText = '';
        try {
          if (!cfg.groupId) throw new Error('cfg.groupId missing');
          const userId = await noblox.getIdFromUsername(username);
          if (typeof noblox.handleJoinRequest === 'function') {
            await noblox.handleJoinRequest(cfg.groupId, userId, true);
            logText = `Completed: Accepted join for ${username}`;
            await safeReply(interaction, { content: `✅ Accepted join for ${username}`, ephemeral: true });
          } else {
            await noblox.setRank(cfg.groupId, userId, 1);
            logText = `Completed (fallback): Set rank 1 for ${username}`;
            await safeReply(interaction, { content: `✅ Accepted (fallback) for ${username}`, ephemeral: true });
          }
        } catch (err) {
          console.error('accept err', err);
          logText = `Failed: Accept ${username} — ${err?.message || err}`;
          await safeReply(interaction, { content: `❌ Failed to accept: ${err?.message || err}`, ephemeral: true });
        }
        try {
          const sig = signatureFromPayload({ content: 'Choose an action:' });
          const menuMsg = await findRegisteredMessageForSignature(sig, interaction.channelId);
          await cleanupAndLog({ interaction, menuMessage: menuMsg, logText });
        } catch {}
        return;
      }

      // tracker add/promote/remove
      if (modalId.startsWith('tracker_modal_add_')) {
        const username = interaction.fields.getTextInputValue('username').trim();
        const placement = interaction.fields.getTextInputValue('placement').trim();
        await safeReply(interaction, { content: `Adding ${username} to tracker...`, ephemeral: true });
        let logText = '';
        try {
          const sheet = await getSheetOrReply(sheetDoc, 'Tracker', interaction);
          if (!sheet) throw new Error('Tracker sheet missing');
          await sheet.addRow({ Username: username, Placement: placement, Date: new Date().toISOString() });
          logText = `Completed: Added ${username} as ${placement}`;
          await safeReply(interaction, { content: `✅ Added ${username} as ${placement}`, ephemeral: true });
        } catch (err) {
          console.error('tracker add err', err);
          logText = `Failed: Add ${username} — ${err?.message || err}`;
          await safeReply(interaction, { content: `❌ Failed to add: ${err?.message || err}`, ephemeral: true });
        }
        try {
          const sig = signatureFromPayload({ content: 'Choose a tracker action' });
          const menuMsg = await findRegisteredMessageForSignature(sig, interaction.channelId);
          await cleanupAndLog({ interaction, menuMessage: menuMsg, logText });
        } catch {}
        return;
      }

      if (modalId.startsWith('tracker_modal_promote_')) {
        const username = interaction.fields.getTextInputValue('username').trim();
        const newplacement = interaction.fields.getTextInputValue('newplacement').trim();
        await safeReply(interaction, { content: `Promoting ${username}...`, ephemeral: true });
        let logText = '';
        try {
          const sheet = await getSheetOrReply(sheetDoc, 'Tracker', interaction);
          if (!sheet) throw new Error('Tracker sheet missing');
          const rows = await sheet.getRows();
          const row = rows.find(r => String(r.Username || '').toLowerCase() === username.toLowerCase());
          if (!row) throw new Error('User not found in tracker');
          row.Placement = newplacement;
          row.Date = new Date().toISOString();
          await row.save();
          logText = `Completed: Promoted ${username} to ${newplacement}`;
          await safeReply(interaction, { content: `✅ Promoted ${username} to ${newplacement}`, ephemeral: true });
        } catch (err) {
          console.error('promote err', err);
          logText = `Failed: Promote ${username} — ${err?.message || err}`;
          await safeReply(interaction, { content: `❌ Failed to promote: ${err?.message || err}`, ephemeral: true });
        }
        try {
          const sig = signatureFromPayload({ content: 'Choose a tracker action' });
          const menuMsg = await findRegisteredMessageForSignature(sig, interaction.channelId);
          await cleanupAndLog({ interaction, menuMessage: menuMsg, logText });
        } catch {}
        return;
      }

      if (modalId.startsWith('tracker_modal_remove_')) {
        const username = interaction.fields.getTextInputValue('username').trim();
        await safeReply(interaction, { content: `Removing ${username}...`, ephemeral: true });
        let logText = '';
        try {
          const sheet = await getSheetOrReply(sheetDoc, 'Tracker', interaction);
          if (!sheet) throw new Error('Tracker sheet missing');
          const rows = await sheet.getRows();
          const row = rows.find(r => String(r.Username || '').toLowerCase() === username.toLowerCase());
          if (!row) throw new Error('User not found in tracker');
          await row.delete();
          logText = `Completed: Removed ${username}`;
          await safeReply(interaction, { content: `✅ Removed ${username} from tracker`, ephemeral: true });
        } catch (err) {
          console.error('remove err', err);
          logText = `Failed: Remove ${username} — ${err?.message || err}`;
          await safeReply(interaction, { content: `❌ Failed to remove: ${err?.message || err}`, ephemeral: true });
        }
        try {
          const sig = signatureFromPayload({ content: 'Choose a tracker action' });
          const menuMsg = await findRegisteredMessageForSignature(sig, interaction.channelId);
          await cleanupAndLog({ interaction, menuMessage: menuMsg, logText });
        } catch {}
        return;
      }
    }

  } catch (err) {
    console.error('Unhandled interaction error', err);
    try {
      if (interaction && !interaction.replied && !interaction.deferred) await safeSendAndReturnMessage(interaction, { content: '❌ Internal error', ephemeral: true });
    } catch {}
  }
});

// --- Sheets init ---
const { GoogleAuth } = require('google-auth-library');
async function initSheets() {
  if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !process.env.SPREADSHEET_ID) { console.warn('Sheets creds missing; skipping'); return null; }
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;
  try { privateKey = privateKey.replace(/\\n/g, '\n'); } catch {}
  const auth = new GoogleAuth({ credentials: { client_email: process.env.GOOGLE_CLIENT_EMAIL, private_key: privateKey }, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, auth);
  await doc.loadInfo();
  sheetDoc = doc;
  console.log('✅ Google Sheets connected:', doc.title);
  return doc;
}

// startup
(async ()=> {
  try {
    await initSheets();
    await client.login(process.env.DISCORD_TOKEN);
  } catch (e) { console.error('Startup error', e); }
})();

client.on('error', (e) => console.error('Discord client error', e));
process.on('unhandledRejection', (r) => console.error('Unhandled Rejection:', r));
process.on('uncaughtException', (e) => console.error('Uncaught Exception:', e));
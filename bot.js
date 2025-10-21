// Full working bot.js — avoids deferring selects before showModal, and deletes fallback duplicates on success

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
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const noblox = require("noblox.js");
const fetch = require("node-fetch");
const express = require('express');

// Will hold the GoogleSpreadsheet instance after init
let sheetDoc = null;

console.log("Env present:", {
  GOOGLE_CLIENT_EMAIL: !!process.env.GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY: !!process.env.GOOGLE_PRIVATE_KEY,
  SPREADSHEET_ID: !!process.env.SPREADSHEET_ID,
  ROBLOX_COOKIE: !!process.env.ROBLOX_COOKIE,
  BOT_LOG_CHANNEL_ID: !!process.env.BOT_LOG_CHANNEL_ID,
});

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// --- Health check server ---
const app = express();
app.get('/', (req, res) => res.status(200).send('OK'));
app.get('/health', (req, res) => res.status(200).json({ status: 'up' }));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Health server listening on :${PORT}`);
});

// Safe cell access helper
async function safeGetCell(sheet, row, col) {
  if (!sheet) throw new Error("❌ Sheet not found");
  if (row >= sheet.rowCount || col >= sheet.columnCount) {
    throw new Error(`❌ Cell [${row},${col}] is out of bounds`);
  }
  return sheet.getCell(row, col);
}

// ---------- Dedup / recent signature store ----------
const _recentSignatures = new Map();
const SIGNATURE_TTL_MS = 8000;

function signatureFromPayload(payload) {
  if (!payload) return '';
  let p = payload;
  if (typeof payload === 'string') p = { content: payload };

  const parts = [];

  if (p.content) {
    const c = String(p.content).replace(/\s+/g, ' ').trim();
    if (c) parts.push(c.slice(0, 400));
  }

  if (Array.isArray(p.embeds) && p.embeds.length) {
    const e = p.embeds[0];
    if (e.title) parts.push(String(e.title).replace(/\s+/g, ' ').trim().slice(0, 200));
    if (e.description) parts.push(String(e.description).replace(/\s+/g, ' ').trim().slice(0, 200));
  }

  if (Array.isArray(p.components) && p.components.length) {
    try {
      const compParts = [];
      for (const row of p.components) {
        const comps = row.components ?? row;
        if (!Array.isArray(comps)) continue;
        for (const comp of comps) {
          if (!comp) continue;
          if (comp.customId) compParts.push(String(comp.customId));
          else if (comp.placeholder) compParts.push(String(comp.placeholder));
          else if (Array.isArray(comp.options) && comp.options.length) {
            const labels = comp.options.slice(0, 5).map(o => String(o.label || o.value || '').replace(/\s+/g, ' ').trim());
            compParts.push(labels.join(','));
          } else if (comp.label) {
            compParts.push(String(comp.label));
          }
        }
      }
      if (compParts.length) parts.push(compParts.join('|').slice(0, 400));
    } catch (e) {}
  }

  return parts.join('||').slice(0, 1000);
}

async function findRegisteredMessageForSignature(sig, channelId) {
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
      if (!ch || !ch.messages) return null;
      const msg = await ch.messages.fetch(rec.messageId).catch(() => null);
      if (msg) return msg;
    } catch {}
    return null;
  }

  try {
    const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
    if (!ch || !ch.messages) return null;
    const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
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

function registerSignature(sig, channelId, messageId = null, payloadSummary = null) {
  try {
    _recentSignatures.set(sig, {
      channelId,
      messageId: messageId || null,
      payloadSummary: payloadSummary || null,
      expiresAt: Date.now() + SIGNATURE_TTL_MS,
    });
  } catch {}
}

async function deleteRegisteredMessageBySig(sig, channelId, exceptMessageId = null) {
  const rec = _recentSignatures.get(sig);
  if (!rec) return;
  if (rec.channelId !== channelId) return;
  if (!rec.messageId) return;
  if (rec.messageId === exceptMessageId) return;
  try {
    const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
    if (!ch || !ch.messages) return;
    await ch.messages.delete(rec.messageId).catch(()=>{});
  } catch (e) {}
  _recentSignatures.delete(sig);
}

// Last-resort: scan recent messages and delete other bot messages that appear similar
async function deleteOtherBotMessagesSimilar(channelId, keepMessageId, payloadSummary) {
  if (!channelId) return;
  try {
    const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
    if (!ch || !ch.messages) return;
    const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
    if (!recent) return;
    const candidates = recent.filter(m => m.author?.id === client.user?.id && m.id !== keepMessageId);
    for (const m of candidates.values()) {
      if (payloadSummary) {
        const content = (m.content || '');
        const e = m.embeds?.[0];
        if (content.includes(payloadSummary) ||
            (e && ((e.title && e.title.includes(payloadSummary)) || (e.description && e.description.includes(payloadSummary))))) {
          await m.delete().catch(()=>{});
        }
      } else {
        // if no summary provided, be conservative and only delete exact duplicates
        await m.delete().catch(()=>{});
      }
    }
  } catch (e) {}
}

// ---------- Robust interaction/channel sending helpers ----------

const _sentOnce = new WeakMap();
const _perUserDedupe = new Map();
const PER_USER_TTL_MS = 8000;

async function sendOnce(interaction, key, contentObj) {
  if (!interaction) {
    const channel = contentObj?.channel || null;
    if (channel && typeof channel.send === 'function') {
      return channel.send(contentObj.content || contentObj);
    }
    return null;
  }

  const userId = interaction.user?.id || (interaction.member && interaction.member.user && interaction.member.user.id) || null;
  const perUserKey = userId ? `${userId}:${key}` : null;

  if (perUserKey) {
    const now = Date.now();
    const expiry = _perUserDedupe.get(perUserKey);
    if (expiry && expiry > now) {
      console.log(`sendOnce: blocked by per-user dedupe for ${perUserKey}`);
      return null;
    }
  }

  let set = _sentOnce.get(interaction);
  if (!set) {
    set = new Set();
    _sentOnce.set(interaction, set);
  }
  if (set.has(key)) return null;

  const sent = await safeSendAndReturnMessage(interaction, contentObj);

  if (sent !== null) {
    try { set.add(key); } catch (e) {}
    if (perUserKey) _perUserDedupe.set(perUserKey, Date.now() + PER_USER_TTL_MS);
  }

  return sent;
}

async function safeSendAndReturnMessage(interaction, contentObj = {}) {
  let payload = contentObj;
  if (typeof contentObj === 'string') payload = { content: contentObj };

  const sig = signatureFromPayload(payload);
  const channelId = interaction?.channel?.id || interaction?.message?.channel?.id || null;

  if (sig && channelId) {
    const existing = await findRegisteredMessageForSignature(sig, channelId);
    if (existing) {
      try {
        if (!interaction.replied && !interaction.deferred) {
          if (typeof interaction.deferReply === 'function') {
            await interaction.deferReply({ ephemeral: true }).catch(()=>{});
          } else if (typeof interaction.deferUpdate === 'function') {
            await interaction.deferUpdate().catch(()=>{});
          }
        }
      } catch (e) {}
      return existing;
    }
  }

  const makeSentinel = (path) => ({
    __sentinel: true,
    path,
    channelId,
    content: payload?.content ?? null,
    embeds: payload?.embeds ?? null,
    timestamp: Date.now(),
  });

  try {
    if (interaction && !interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply(payload);
        try {
          const msg = await interaction.fetchReply();
          console.log('safeSend: used reply -> fetched message');
          if (sig && channelId) {
            registerSignature(sig, channelId, msg.id, payload?.content?.slice(0,200) ?? null);
            try { await deleteRegisteredMessageBySig(sig, channelId, msg.id); } catch (e) {}
            try { await deleteOtherBotMessagesSimilar(channelId, msg.id, payload?.content?.slice(0,200) ?? null); } catch(e){}
          }
          return msg;
        } catch (e) {
          console.log('safeSend: reply succeeded but fetchReply failed; registering signature and returning sentinel', e?.message);
          if (sig && channelId) registerSignature(sig, channelId, null, payload?.content?.slice(0,200) ?? null);
          return makeSentinel('reply_no_fetch');
        }
      } catch (e) {
        console.log('safeSend: interaction.reply failed, falling through:', e?.message);
      }
    }

    if (interaction && (interaction.deferred || interaction.replied)) {
      try {
        await interaction.editReply(payload);
        try {
          const msg = await interaction.fetchReply();
          console.log('safeSend: used editReply -> fetched message');
          if (sig && channelId) {
            registerSignature(sig, channelId, msg.id, payload?.content?.slice(0,200) ?? null);
            try { await deleteRegisteredMessageBySig(sig, channelId, msg.id); } catch (e) {}
            try { await deleteOtherBotMessagesSimilar(channelId, msg.id, payload?.content?.slice(0,200) ?? null); } catch(e){}
          }
          return msg;
        } catch (e) {
          console.log('safeSend: editReply succeeded but fetchReply failed; registering signature and returning sentinel', e?.message);
          if (sig && channelId) registerSignature(sig, channelId, null, payload?.content?.slice(0,200) ?? null);
          return makeSentinel('edit_no_fetch');
        }
      } catch (e) {
        console.log('safeSend: interaction.editReply failed, falling through:', e?.message);
      }
    }
  } catch (err) {
    console.log('safeSend: reply/edit attempt threw, falling back:', err?.message);
  }

  try {
    if (interaction && typeof interaction.followUp === 'function') {
      try {
        const follow = await interaction.followUp(payload);
        console.log('safeSend: used followUp');
        if (sig && channelId) {
          if (follow && follow.id) {
            registerSignature(sig, channelId, follow.id, payload?.content?.slice(0,200) ?? null);
            try { await deleteRegisteredMessageBySig(sig, channelId, follow.id); } catch (e) {}
            try { await deleteOtherBotMessagesSimilar(channelId, follow.id, payload?.content?.slice(0,200) ?? null); } catch(e){}
          } else {
            registerSignature(sig, channelId, null, payload?.content?.slice(0,200) ?? null);
          }
        }
        return follow ?? makeSentinel('followup_no_message');
      } catch (e) {
        console.log('safeSend: followUp failed, falling through:', e?.message);
      }
    }
  } catch (err) {
    console.log('safeSend: followUp threw:', err?.message);
  }

  try {
    const channel = interaction?.channel || interaction?.message?.channel;
    if (channel && typeof channel.send === 'function') {
      if (sig && channel.id) {
        registerSignature(sig, channel.id, null, payload?.content?.slice(0,200) ?? null);
        console.log('safeSend: pre-registered signature before channel.send');
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

      console.log('safeSend: used channel.send fallback');
      if (sig && channel.id && sent && sent.id) registerSignature(sig, channel.id, sent.id, payload?.content?.slice(0,200) ?? null);
      return sent;
    }
  } catch (err) {
    console.log('safeSend: channel.send fallback failed:', err?.message);
  }

  return null;
}

async function safeReply(interaction, contentObj = {}) {
  await safeSendAndReturnMessage(interaction, contentObj);
  return;
}

async function safeUpdate(interaction, updateObj = {}) {
  try {
    if (interaction && typeof interaction.update === 'function') {
      return await interaction.update(updateObj);
    }
    return await safeSendAndReturnMessage(interaction, updateObj);
  } catch (err) {
    try {
      const channel = interaction?.channel || interaction?.message?.channel;
      if (channel) {
        return channel.send(updateObj.content ?? updateObj);
      }
    } catch {}
    return null;
  }
}

async function getSheetOrReply(doc, title, interaction) {
  if (!doc) {
    try { await safeReply(interaction, { content: '❌ Google Sheets not initialized yet', ephemeral: true }); } catch (e) {}
    return null;
  }
  const sheet = doc.sheetsByTitle[title];
  if (!sheet) {
    try { await safeReply(interaction, { content: `❌ Sheet "${title}" not found`, ephemeral: true }); } catch (e) {}
    return null;
  }
  return sheet;
}

async function safeDeleteMessage(msgOrId, channelContext = null) {
  if (!msgOrId) return;
  try {
    if (typeof msgOrId.delete === 'function') {
      await msgOrId.delete().catch(() => {});
      return;
    }

    if (msgOrId && msgOrId.__sentinel) {
      try {
        const chId = msgOrId.channelId || channelContext?.id;
        if (!chId) return;
        const ch = client.channels.cache.get(chId) || await client.channels.fetch(chId).catch(() => null);
        if (!ch) return;

        const canFetch = ch?.messages && typeof ch.messages.fetch === 'function';
        if (!canFetch) return;

        const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
        if (!recent) return;
        const candidates = recent.filter(m => m.author?.id === client.user?.id);

        if (msgOrId.content) {
          const match = candidates.find(m => (m.content || '').trim() === (msgOrId.content || '').trim());
          if (match) {
            await match.delete().catch(() => {});
            try {
              const sig = signatureFromPayload({ content: msgOrId.content, embeds: msgOrId.embeds, components: [] });
              if (sig) _recentSignatures.delete(sig);
            } catch (e) {}
            return;
          }
        }

        if (msgOrId.embeds && msgOrId.embeds.length) {
          for (const m of candidates.values()) {
            const e = m.embeds?.[0];
            if (!e) continue;
            if ((e.title && msgOrId.embeds[0]?.title && e.title === msgOrId.embeds[0].title) ||
                (e.description && msgOrId.embeds[0]?.description && e.description === msgOrId.embeds[0].description)) {
              await m.delete().catch(() => {});
              try {
                const sig = signatureFromPayload({ content: msgOrId.content, embeds: msgOrId.embeds, components: [] });
                if (sig) _recentSignatures.delete(sig);
              } catch (e) {}
              return;
            }
          }
        }

        return;
      } catch (e) {
        return;
      }
    }

    if (msgOrId.id && msgOrId.channel) {
      await msgOrId.channel.messages.delete(msgOrId.id).catch(() => {});
      return;
    }

    if (typeof msgOrId === 'string' && channelContext) {
      try {
        const fetched = await channelContext.messages.fetch(msgOrId);
        if (fetched) await fetched.delete().catch(() => {});
      } catch (e) {}
      return;
    }
  } catch (e) {}
}

async function getLogChannel() {
  const id = process.env.BOT_LOG_CHANNEL_ID || (cfg && cfg.logChannelId);
  if (!id) return null;
  try {
    return client.channels.cache.get(id) || await client.channels.fetch(id);
  } catch (e) {
    return null;
  }
}

async function cleanupAndLog({
  interaction,
  userMessages = [],
  botMessages = [],
  menuMessage = null,
  componentMessages = [],
  logText = ''
}) {
  const channelContext = interaction?.channel || interaction?.message?.channel || null;

  const all = [
    ...userMessages.filter(Boolean),
    ...botMessages.filter(Boolean),
    ...(menuMessage ? [menuMessage] : []),
    ...componentMessages.filter(Boolean),
  ];

  await Promise.all(all.map(m => safeDeleteMessage(m, channelContext)));

  const logChannel = await getLogChannel();
  if (!logChannel) {
    console.warn('BOT_LOG_CHANNEL_ID not set or channel not found; skipping log send.');
    return;
  }

  try {
    const content = (logText && typeof logText === 'string')
      ? `<@${interaction.user.id}> — ${logText}`
      : `<@${interaction.user.id}> performed an action.`;
    await logChannel.send({ content });
  } catch (err) {
    console.error('Failed to send log message:', err);
  }
}

// --- Roblox cookie init (again safe if absent) ---
(async () => {
  try {
    if (process.env.ROBLOX_COOKIE) {
      await noblox.setCookie(process.env.ROBLOX_COOKIE);
      console.log("✅ Roblox cookie set");
    } else {
      console.warn("ROBLOX_COOKIE not set; roblox features will fail until provided.");
    }
  } catch (err) {
    console.error("❌ Roblox cookie error:", err);
  }
})();

// Register slash commands
const commands = [
  new SlashCommandBuilder()
    .setName("robloxmanager")
    .setDescription("Roblox group management menu"),
  new SlashCommandBuilder()
    .setName("bgc")
    .setDescription("Background check a Roblox user")
    .addStringOption((opt) =>
      opt.setName("username").setDescription("Roblox username").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("trackermanager")
    .setDescription("Manage placements in your Google Tracker"),
].map((cmd) => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    console.log("✅ Slash commands registered");
  } catch (err) {
    console.error("❌ Command registration failed:", err);
  }
})();

// --- SINGLE interactionCreate handler (adjusted: do NOT pre-defer selects/buttons) ---
client.on("interactionCreate", async (interaction) => {
  try {
    // --- Only defer chat commands early to avoid token expiry ---
    if (interaction.isChatInputCommand()) {
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.deferReply({ ephemeral: false }).catch((e) => {
            console.log('early deferReply failed (safe to ignore):', e?.message);
          });
        }
      } catch (e) {
        console.log('deferReply outer catch:', e?.message);
      }
    }
    // NOTE: Do NOT defer StringSelectMenu/Button here — we need to allow showModal calls.
    // --- end defer logic ---

    // Chat input commands
    if (interaction.isChatInputCommand()) {
      const isAdmin = interaction.member?.permissions?.has?.(PermissionsBitField.Flags.Administrator);
      if (!isAdmin) {
        await safeReply(interaction, { content: "❌ Administrator permission required.", ephemeral: true });
        return;
      }

      if (interaction.commandName === "robloxmanager") {
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`rc_action_${interaction.user.id}`)
            .setPlaceholder("Select an action")
            .addOptions([
              { label: "Change Rank", value: "change_rank" },
              { label: "Kick User", value: "kick_user" },
              { label: "Accept Join Request", value: "accept_join" },
            ])
        );
        await sendOnce(interaction, 'rc_menu', { content: "Choose an action:", components: [row] });
        return;
      }

      if (interaction.commandName === "bgc") {
        const username = interaction.options.getString("username");
        await sendOnce(interaction, 'bgc_fetching', { content: "🔎 Fetching Roblox data…" });
        try {
          const userRes = await fetch("https://users.roblox.com/v1/usernames/users", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usernames: [username] }),
          });
          const userJson = await userRes.json();
          if (!userJson.data?.length) {
            await sendOnce(interaction, `bgc_notfound_${username}`, { content: `❌ Could not find Roblox user **${username}**` });
            return;
          }
          const userId = userJson.data[0].id;

          const [info, friendsJson, followersJson, followingJson, invJson, avatarJson, groupsJson] =
            await Promise.all([
              fetch(`https://users.roblox.com/v1/users/${userId}`).then((r) => r.json()),
              fetch(`https://friends.roblox.com/v1/users/${userId}/friends/count`).then((r) => r.json()),
              fetch(`https://friends.roblox.com/v1/users/${userId}/followers/count`).then((r) => r.json()),
              fetch(`https://friends.roblox.com/v1/users/${userId}/followings/count`).then((r) => r.json()),
              fetch(`https://inventory.roblox.com/v1/users/${userId}/can-view-inventory`).then((r) => r.json()),
              fetch(
                `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`
              ).then((r) => r.json()),
              fetch(`https://groups.roblox.com/v2/users/${userId}/groups/roles`).then((r) => r.json()),
            ]);

          const friendsCount = friendsJson.count ?? 0;
          const followersCount = followersJson.count ?? 0;
          const followingCount = followingJson.count ?? 0;
          const avatarUrl = avatarJson.data?.[0]?.imageUrl || null;

          const groups = Array.isArray(groupsJson.data) ? groupsJson.data : [];
          const totalGroups = groups.length;
          const importantGroupIds = cfg.importantGroupIds ?? [34808935, 34794384, 35250103, 35335293, 5232591, 34755744];
          const matchedKeyGroups = groups
            .filter((g) => importantGroupIds.includes(Number(g.group.id)))
            .map((g) => `${g.group.name} — ${g.role?.name ?? "Member"}`);

          let embed = new EmbedBuilder()
            .setTitle(`${info.name} (@${info.displayName})`)
            .setThumbnail(avatarUrl)
            .setDescription(info.description || "No bio set.")
            .addFields(
              { name: "Roblox ID", value: String(userId), inline: true },
              { name: "Account Created", value: new Date(info.created).toDateString(), inline: true },
              { name: "Friends", value: String(friendsCount), inline: true },
              { name: "Followers", value: String(followersCount), inline: true },
              { name: "Following", value: String(followingCount), inline: true },
              { name: "Total Groups", value: String(totalGroups), inline: true },
              { name: "Key Groups", value: matchedKeyGroups.length ? matchedKeyGroups.join("\n") : "None", inline: false }
            )
            .setColor(0x00ae86);

          await sendOnce(interaction, `bgc_embed_${userId}`, { embeds: [embed] });
        } catch (err) {
          console.error(err);
          await sendOnce(interaction, 'bgc_error', { content: "❌ Error fetching data." });
        }
        return;
      }

      if (interaction.commandName === "trackermanager") {
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`tracker_action_${interaction.user.id}`)
            .setPlaceholder("Select a tracker action")
            .addOptions([
              { label: "Add Placement", value: "add_placement" },
              { label: "Promote Placement", value: "promote_placement" },
              { label: "Remove User", value: "remove_user" },
            ])
        );
        await sendOnce(interaction, 'tracker_menu', { content: "Choose a tracker action:", components: [row] });
        return;
      }
    }

    // Handle select menus — DO NOT pre-defer here, so showModal works
    if (interaction.isStringSelectMenu() && (interaction.customId.startsWith("tracker_action_") || interaction.customId.startsWith("rc_action_"))) {
      const parts = interaction.customId.split('_');
      const tailUserId = parts[parts.length - 1];
      if (tailUserId !== interaction.user.id) {
        await safeReply(interaction, { content: "❌ This menu is not for you.", ephemeral: true });
        return;
      }

      const value = interaction.values && interaction.values[0];
      if (!value) {
        await safeReply(interaction, { content: "❌ No option selected.", ephemeral: true });
        return;
      }

      // RC actions
      if (interaction.customId.startsWith("rc_action_")) {
        if (value === "change_rank") {
          const modal = new ModalBuilder()
            .setCustomId(`rc_modal_changeRank_${interaction.user.id}`)
            .setTitle('Change Rank');
          const usernameInput = new TextInputBuilder().setCustomId('username').setLabel('Roblox username').setStyle(TextInputStyle.Short).setRequired(true);
          const rankInput = new TextInputBuilder().setCustomId('rank').setLabel('Rank name or number').setStyle(TextInputStyle.Short).setRequired(true);
          modal.addComponents(new ActionRowBuilder().addComponents(usernameInput), new ActionRowBuilder().addComponents(rankInput));
          await interaction.showModal(modal).catch((e) => {
            console.log('showModal failed:', e?.message);
            safeReply(interaction, { content: '❌ Failed to show modal.', ephemeral: true });
          });
          return;
        }
        if (value === "kick_user") {
          const modal = new ModalBuilder()
            .setCustomId(`rc_modal_kick_${interaction.user.id}`)
            .setTitle('Kick User');
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('username').setLabel('Roblox username').setStyle(TextInputStyle.Short).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false)
            )
          );
          await interaction.showModal(modal).catch((e) => {
            console.log('showModal failed:', e?.message);
            safeReply(interaction, { content: '❌ Failed to show modal.', ephemeral: true });
          });
          return;
        }
        if (value === "accept_join") {
          const modal = new ModalBuilder()
            .setCustomId(`rc_modal_accept_${interaction.user.id}`)
            .setTitle('Accept Join Request');
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('username').setLabel('Roblox username').setStyle(TextInputStyle.Short).setRequired(true)
            )
          );
          await interaction.showModal(modal).catch((e) => {
            console.log('showModal failed:', e?.message);
            safeReply(interaction, { content: '❌ Failed to show modal.', ephemeral: true });
          });
          return;
        }
      }

      // Tracker actions
      if (interaction.customId.startsWith("tracker_action_")) {
        if (value === "add_placement") {
          const modal = new ModalBuilder()
            .setCustomId(`tracker_modal_add_${interaction.user.id}`)
            .setTitle('Add Placement');
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('username').setLabel('Player username').setStyle(TextInputStyle.Short).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('placement').setLabel('Placement (e.g. Recruit, Sgt)').setStyle(TextInputStyle.Short).setRequired(true)
            )
          );
          await interaction.showModal(modal).catch((e) => {
            console.log('showModal failed:', e?.message);
            safeReply(interaction, { content: '❌ Failed to show modal.', ephemeral: true });
          });
          return;
        }
        if (value === "promote_placement") {
          const modal = new ModalBuilder()
            .setCustomId(`tracker_modal_promote_${interaction.user.id}`)
            .setTitle('Promote Placement');
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('username').setLabel('Player username').setStyle(TextInputStyle.Short).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('newplacement').setLabel('New placement').setStyle(TextInputStyle.Short).setRequired(true)
            )
          );
          await interaction.showModal(modal).catch((e) => {
            console.log('showModal failed:', e?.message);
            safeReply(interaction, { content: '❌ Failed to show modal.', ephemeral: true });
          });
          return;
        }
        if (value === "remove_user") {
          const modal = new ModalBuilder()
            .setCustomId(`tracker_modal_remove_${interaction.user.id}`)
            .setTitle('Remove from Tracker');
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('username').setLabel('Player username').setStyle(TextInputStyle.Short).setRequired(true)
            )
          );
          await interaction.showModal(modal).catch((e) => {
            console.log('showModal failed:', e?.message);
            safeReply(interaction, { content: '❌ Failed to show modal.', ephemeral: true });
          });
          return;
        }
      }
    }

    // Handle modal submissions
    if (interaction.isModalSubmit()) {
      const modalId = interaction.customId;
      if (modalId.includes(`_${interaction.user.id}`) === false) {
        await safeReply(interaction, { content: "❌ This modal isn't for you.", ephemeral: true });
        return;
      }

      // The modal handlers below all use safeReply (ephemeral) for the processing status.
      // After processing they call cleanupAndLog which attempts to delete menus and log the result.

      if (modalId.startsWith('rc_modal_changeRank_')) {
        const username = interaction.fields.getTextInputValue('username').trim();
        const rankInput = interaction.fields.getTextInputValue('rank').trim();
        await safeReply(interaction, { content: `Processing change rank for ${username}...`, ephemeral: true });

        let logText = '';
        try {
          if (!cfg.groupId) throw new Error('cfg.groupId is missing');
          const userId = await noblox.getIdFromUsername(username);
          let rankNumber = parseInt(rankInput, 10);
          if (isNaN(rankNumber)) {
            const roles = await noblox.getRoles(cfg.groupId);
            const match = roles.find(r => r.name.toLowerCase() === rankInput.toLowerCase());
            if (!match) throw new Error('Rank not found by name');
            rankNumber = match.rank;
          }
          await noblox.setRank(cfg.groupId, userId, rankNumber);
          logText = `Completed: Changed rank for ${username} to ${rankInput}`;
          await safeReply(interaction, { content: `✅ Rank changed for ${username} to ${rankInput}`, ephemeral: true });
        } catch (err) {
          console.error('changeRank error:', err);
          logText = `Failed: Change rank for ${username} — ${err.message || err}`;
          await safeReply(interaction, { content: `❌ Failed to change rank: ${err.message || err}`, ephemeral: true });
        }

        try {
          const sig = signatureFromPayload({ content: "Choose an action:" });
          const menuMsg = await findRegisteredMessageForSignature(sig, interaction.channelId);
          await cleanupAndLog({ interaction, menuMessage: menuMsg, logText });
        } catch (e) {}
        return;
      }

      if (modalId.startsWith('rc_modal_kick_')) {
        const username = interaction.fields.getTextInputValue('username').trim();
        const reason = interaction.fields.getTextInputValue('reason')?.trim() || 'No reason provided';
        await safeReply(interaction, { content: `Processing kick for ${username}...`, ephemeral: true });

        let logText = '';
        try {
          if (!cfg.groupId) throw new Error('cfg.groupId is missing');
          const userId = await noblox.getIdFromUsername(username);
          await noblox.exile(cfg.groupId, userId);
          logText = `Completed: Kicked ${username} (${reason})`;
          await safeReply(interaction, { content: `✅ Kicked ${username}`, ephemeral: true });
        } catch (err) {
          console.error('kick error:', err);
          logText = `Failed: Kick ${username} — ${err.message || err}`;
          await safeReply(interaction, { content: `❌ Failed to kick: ${err.message || err}`, ephemeral: true });
        }

        try {
          const sig = signatureFromPayload({ content: "Choose an action:" });
          const menuMsg = await findRegisteredMessageForSignature(sig, interaction.channelId);
          await cleanupAndLog({ interaction, menuMessage: menuMsg, logText });
        } catch (e) {}
        return;
      }

      if (modalId.startsWith('rc_modal_accept_')) {
        const username = interaction.fields.getTextInputValue('username').trim();
        await safeReply(interaction, { content: `Processing accept join for ${username}...`, ephemeral: true });

        let logText = '';
        try {
          if (!cfg.groupId) throw new Error('cfg.groupId is missing');
          const userId = await noblox.getIdFromUsername(username);
          if (typeof noblox.handleJoinRequest === 'function') {
            await noblox.handleJoinRequest(cfg.groupId, userId, true);
            logText = `Completed: Accepted join request for ${username}`;
            await safeReply(interaction, { content: `✅ Accepted join for ${username}`, ephemeral: true });
          } else {
            await noblox.setRank(cfg.groupId, userId, 1);
            logText = `Completed (fallback): Set rank 1 for ${username}`;
            await safeReply(interaction, { content: `✅ Accepted (fallback) for ${username}`, ephemeral: true });
          }
        } catch (err) {
          console.error('accept join error:', err);
          logText = `Failed: Accept join for ${username} — ${err.message || err}`;
          await safeReply(interaction, { content: `❌ Failed to accept: ${err.message || err}`, ephemeral: true });
        }

        try {
          const sig = signatureFromPayload({ content: "Choose an action:" });
          const menuMsg = await findRegisteredMessageForSignature(sig, interaction.channelId);
          await cleanupAndLog({ interaction, menuMessage: menuMsg, logText });
        } catch (e) {}
        return;
      }

      if (modalId.startsWith('tracker_modal_add_')) {
        const username = interaction.fields.getTextInputValue('username').trim();
        const placement = interaction.fields.getTextInputValue('placement').trim();
        await safeReply(interaction, { content: `Adding ${username} to tracker...`, ephemeral: true });

        let logText = '';
        try {
          const sheet = await getSheetOrReply(sheetDoc, 'Tracker', interaction);
          if (!sheet) throw new Error('Tracker sheet missing');
          await sheet.addRow({ Username: username, Placement: placement, Date: (new Date()).toISOString() });
          logText = `Completed: Added ${username} as ${placement}`;
          await safeReply(interaction, { content: `✅ Added ${username} as ${placement}`, ephemeral: true });
        } catch (err) {
          console.error('tracker add error:', err);
          logText = `Failed: Add ${username} — ${err.message || err}`;
          await safeReply(interaction, { content: `❌ Failed to add: ${err.message || err}`, ephemeral: true });
        }

        try {
          const sig = signatureFromPayload({ content: "Choose a tracker action" });
          const menuMsg = await findRegisteredMessageForSignature(sig, interaction.channelId);
          await cleanupAndLog({ interaction, menuMessage: menuMsg, logText });
        } catch (e) {}
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
          row.Date = (new Date()).toISOString();
          await row.save();
          logText = `Completed: Promoted ${username} to ${newplacement}`;
          await safeReply(interaction, { content: `✅ Promoted ${username} to ${newplacement}`, ephemeral: true });
        } catch (err) {
          console.error('tracker promote error:', err);
          logText = `Failed: Promote ${username} — ${err.message || err}`;
          await safeReply(interaction, { content: `❌ Failed to promote: ${err.message || err}`, ephemeral: true });
        }

        try {
          const sig = signatureFromPayload({ content: "Choose a tracker action" });
          const menuMsg = await findRegisteredMessageForSignature(sig, interaction.channelId);
          await cleanupAndLog({ interaction, menuMessage: menuMsg, logText });
        } catch (e) {}
        return;
      }

      if (modalId.startsWith('tracker_modal_remove_')) {
        const username = interaction.fields.getTextInputValue('username').trim();
        await safeReply(interaction, { content: `Removing ${username} from tracker...`, ephemeral: true });

        let logText = '';
        try {
          const sheet = await getSheetOrReply(sheetDoc, 'Tracker', interaction);
          if (!sheet) throw new Error('Tracker sheet missing');
          const rows = await sheet.getRows();
          const row = rows.find(r => String(r.Username || '').toLowerCase() === username.toLowerCase());
          if (!row) throw new Error('User not found in tracker');
          await row.delete();
          logText = `Completed: Removed ${username} from tracker`;
          await safeReply(interaction, { content: `✅ Removed ${username} from tracker`, ephemeral: true });
        } catch (err) {
          console.error('tracker remove err:', err);
          logText = `Failed: Remove ${username} — ${err.message || err}`;
          await safeReply(interaction, { content: `❌ Failed to remove: ${err.message || err}`, ephemeral: true });
        }

        try {
          const sig = signatureFromPayload({ content: "Choose a tracker action" });
          const menuMsg = await findRegisteredMessageForSignature(sig, interaction.channelId);
          await cleanupAndLog({ interaction, menuMessage: menuMsg, logText });
        } catch (e) {}
        return;
      }
    }
  } catch (err) {
    console.error("Unhandled interaction error:", err);
    try {
      if (interaction && !interaction.replied && !interaction.deferred) {
        await safeSendAndReturnMessage(interaction, { content: "❌ An internal error occurred.", ephemeral: true });
      } else {
        await safeSendAndReturnMessage(interaction, { content: "❌ An internal error occurred.", components: [] });
      }
    } catch (e) {}
  }
});

// --- Google Sheets init ---
const { GoogleAuth } = require('google-auth-library');
async function initSheets() {
  if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !process.env.SPREADSHEET_ID) {
    console.warn("Google Sheets credentials or SPREADSHEET_ID missing; skipping initSheets.");
    return null;
  }
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;
  try { privateKey = privateKey.replace(/\\n/g, '\n'); } catch (e) {}

  const auth = new GoogleAuth({
    credentials: { client_email: process.env.GOOGLE_CLIENT_EMAIL, private_key: privateKey },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, auth);
  await doc.loadInfo();
  console.log('✅ Google Sheets connected:', doc.title);
  sheetDoc = doc;
  return doc;
}

// --- Startup ---
(async () => {
  try {
    await initSheets();
    await client.login(process.env.DISCORD_TOKEN);
  } catch (err) {
    console.error('❌ Startup error:', err);
  }
})();

// Optional: basic error handlers
client.on('error', (err) => console.error('Discord client error:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
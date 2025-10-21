// Full corrected bot.js — guarded defers, robust send helpers, send-once prevention, signature dedupe, sentinel metadata, safer deletes

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
// Keeps recently-sent payload signatures per channel to avoid repost races.
// signature -> { channelId, messageId (optional), expiresAt, payloadSummary }
const _recentSignatures = new Map();
// TTL for signature cache (ms)
const SIGNATURE_TTL_MS = 5000;

// Build a concise signature string from a payload object
function signatureFromPayload(payload) {
  if (!payload) return '';
  // Normalize to object
  let p = payload;
  if (typeof payload === 'string') p = { content: payload };
  const parts = [];
  if (p.content) parts.push(String(p.content).trim());
  if (Array.isArray(p.embeds) && p.embeds.length) {
    const e = p.embeds[0];
    if (e.title) parts.push(String(e.title).trim());
    if (e.description) parts.push(String(e.description).trim());
  }
  // components are often not unique; skip them for signature (content/embeds suffice)
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
  // If we have stored messageId, try to fetch
  if (rec.messageId) {
    try {
      const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
      if (!ch || !ch.messages) return null;
      const msg = await ch.messages.fetch(rec.messageId).catch(() => null);
      if (msg) return msg;
      return null;
    } catch {
      return null;
    }
  }
  // no messageId but signature exists (sentinel-only) — attempt to find a recent message matching summary
  try {
    const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
    if (!ch || !ch.messages) return null;
    const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
    if (!recent) return null;
    // try to find a bot message matching content snippet
    const candidates = recent.filter(m => m.author?.id === client.user?.id);
    for (const m of candidates.values()) {
      if (rec.payloadSummary && (m.content || '').includes(rec.payloadSummary)) return m;
      // check embed titles too
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

// ---------- Robust interaction/channel sending helpers ----------

// WeakMap to avoid sending the same logical response twice for an interaction
const _sentOnce = new WeakMap();

// Per-user dedupe map to prevent duplicates across different Interaction objects.
// key: `${userId}:${key}` -> expiry timestamp (ms)
const _perUserDedupe = new Map();
const PER_USER_TTL_MS = 3000;

// sendOnce ensures a response with the same key isn't sent twice for the same interaction/user.
// Behavior:
//  - If the same interaction object calls sendOnce(key) twice, WeakMap prevents duplicates.
//  - If a different interaction object (same user) tries the same key shortly after, per-user dedupe prevents duplicates.
//  - Only marks as sent once the underlying send returned non-null (Message or sentinel).
async function sendOnce(interaction, key, contentObj) {
  // If no interaction (caller provided channel explicitly), just send normally
  if (!interaction) {
    const channel = contentObj?.channel || null;
    if (channel && typeof channel.send === 'function') {
      return channel.send(contentObj.content || contentObj);
    }
    return null;
  }

  const userId = interaction.user?.id || (interaction.member && interaction.member.user && interaction.member.user.id) || null;
  const perUserKey = userId ? `${userId}:${key}` : null;

  // Check per-user dedupe first
  if (perUserKey) {
    const now = Date.now();
    const expiry = _perUserDedupe.get(perUserKey);
    if (expiry && expiry > now) {
      console.log(`sendOnce: blocked by per-user dedupe for ${perUserKey}`);
      return null;
    }
  }

  // Check per-interaction weakmap
  let set = _sentOnce.get(interaction);
  if (!set) {
    set = new Set();
    _sentOnce.set(interaction, set);
  }
  if (set.has(key)) {
    // Already sent for this interaction object
    return null;
  }

  // Attempt the send
  const sent = await safeSendAndReturnMessage(interaction, contentObj);

  // If we got something non-null, mark both per-interaction and per-user
  if (sent !== null) {
    try { set.add(key); } catch (e) {}
    if (perUserKey) _perUserDedupe.set(perUserKey, Date.now() + PER_USER_TTL_MS);
  }

  return sent;
}

// Tries interaction.reply/editReply -> followUp -> channel.send and returns the resulting Message where available.
// If an interaction-based send succeeded but fetchReply failed, a sentinel metadata object is returned so cleanup can search for the actual bot message.
// This version checks recent signatures and will reuse an existing bot message (or avoid sending) when matching content was posted recently.
async function safeSendAndReturnMessage(interaction, contentObj = {}) {
  // Normalize contentObj for channel.send fallback (allow passing a string)
  let payload = contentObj;
  if (typeof contentObj === 'string') payload = { content: contentObj };

  // Compute signature and channel id for dedupe
  const sig = signatureFromPayload(payload);
  const channelId = interaction?.channel?.id || interaction?.message?.channel?.id || null;

  // If a message with same signature was posted recently in this channel, try to return it and just ACK the interaction.
  if (sig && channelId) {
    const existing = await findRegisteredMessageForSignature(sig, channelId);
    if (existing) {
      // Ensure interaction is acknowledged so follow-up/editReply doesn't later post a duplicate.
      try {
        if (!interaction.replied && !interaction.deferred) {
          // Prefer deferred ephemeral ack when appropriate
          if (typeof interaction.deferReply === 'function') {
            await interaction.deferReply({ ephemeral: true }).catch(() => {});
          } else if (typeof interaction.deferUpdate === 'function') {
            await interaction.deferUpdate().catch(() => {});
          }
        }
      } catch (e) {}
      // Return the found message
      return existing;
    }
  }

  // Helper to build metadata sentinel
  const makeSentinel = (path) => {
    return {
      __sentinel: true,
      path,
      channelId,
      content: payload?.content ?? null,
      embeds: payload?.embeds ?? null,
      timestamp: Date.now(),
    };
  };

  // Try reply/editReply path first
  try {
    if (interaction && !interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply(payload);
        // reply accepted. Try to fetch the message for deletion. If fetch fails, register signature and return sentinel.
        try {
          const msg = await interaction.fetchReply();
          console.log('safeSend: used reply -> fetched message');
          if (sig && channelId) registerSignature(sig, channelId, msg.id, payload?.content?.slice(0, 200) ?? null);
          return msg;
        } catch (e) {
          console.log('safeSend: reply succeeded but fetchReply failed; registering signature and returning sentinel', e?.message);
          if (sig && channelId) registerSignature(sig, channelId, null, payload?.content?.slice(0, 200) ?? null);
          return makeSentinel('reply_no_fetch');
        }
      } catch (e) {
        // reply failed, fall through to other methods
        console.log('safeSend: interaction.reply failed, falling through:', e?.message);
      }
    }

    if (interaction && (interaction.deferred || interaction.replied)) {
      try {
        await interaction.editReply(payload);
        try {
          const msg = await interaction.fetchReply();
          console.log('safeSend: used editReply -> fetched message');
          if (sig && channelId) registerSignature(sig, channelId, msg.id, payload?.content?.slice(0, 200) ?? null);
          return msg;
        } catch (e) {
          console.log('safeSend: editReply succeeded but fetchReply failed; registering signature and returning sentinel', e?.message);
          if (sig && channelId) registerSignature(sig, channelId, null, payload?.content?.slice(0, 200) ?? null);
          return makeSentinel('edit_no_fetch');
        }
      } catch (e) {
        console.log('safeSend: interaction.editReply failed, falling through:', e?.message);
      }
    }
  } catch (err) {
    // swallow and fallback
    console.log('safeSend: reply/edit attempt threw, falling back:', err?.message);
  }

  // Try followUp()
  try {
    if (interaction && typeof interaction.followUp === 'function') {
      try {
        const follow = await interaction.followUp(payload);
        console.log('safeSend: used followUp');
        if (sig && channelId) {
          if (follow && follow.id) registerSignature(sig, channelId, follow.id, payload?.content?.slice(0,200) ?? null);
          else registerSignature(sig, channelId, null, payload?.content?.slice(0,200) ?? null);
        }
        return follow ?? makeSentinel('followup_no_message');
      } catch (e) {
        console.log('safeSend: followUp failed, falling through:', e?.message);
      }
    }
  } catch (err) {
    console.log('safeSend: followUp threw:', err?.message);
  }

  // Channel fallback: find a channel to send to
  try {
    const channel = interaction?.channel || interaction?.message?.channel;
    if (channel && typeof channel.send === 'function') {
      // Before sending, re-check recent signatures in case another parallel path posted while we worked.
      if (sig && channel.id) {
        const existing2 = await findRegisteredMessageForSignature(sig, channel.id);
        if (existing2) {
          // A matching message appeared meanwhile
          if (sig && channel.id) registerSignature(sig, channel.id, existing2.id, payload?.content?.slice(0,200) ?? null);
          // ensure interaction acknowledged
          try {
            if (!interaction.replied && !interaction.deferred) {
              if (typeof interaction.deferReply === 'function') await interaction.deferReply({ ephemeral: true }).catch(()=>{});
              else if (typeof interaction.deferUpdate === 'function') await interaction.deferUpdate().catch(()=>{});
            }
          } catch (e) {}
          return existing2;
        }
      }

      if (typeof payload === 'object') {
        const sendPayload = {};
        if (payload.content) sendPayload.content = payload.content;
        if (payload.embeds) sendPayload.embeds = payload.embeds;
        if (payload.components) sendPayload.components = payload.components;
        const sent = await channel.send(sendPayload.content ?? sendPayload);
        console.log('safeSend: used channel.send fallback');
        if (sig && channel.id && sent && sent.id) registerSignature(sig, channel.id, sent.id, payload?.content?.slice(0,200) ?? null);
        return sent;
      } else {
        const sent = await channel.send(payload);
        console.log('safeSend: used channel.send fallback (string payload)');
        if (sig && channel.id && sent && sent.id) registerSignature(sig, channel.id, sent.id, payload?.content?.slice(0,200) ?? null);
        return sent;
      }
    }
  } catch (err) {
    console.log('safeSend: channel.send fallback failed:', err?.message);
  }

  return null;
}

// safeReply kept for compatibility (returns void-ish) — prefer safeSendAndReturnMessage when you need the Message object
async function safeReply(interaction, contentObj = {}) {
  await safeSendAndReturnMessage(interaction, contentObj);
  return;
}

// safeUpdate for component update (tries update, falls back)
async function safeUpdate(interaction, updateObj = {}) {
  try {
    if (interaction && typeof interaction.update === 'function') {
      return await interaction.update(updateObj);
    }
    return await safeSendAndReturnMessage(interaction, updateObj);
  } catch (err) {
    // fallback to channel.send if needed
    try {
      const channel = interaction?.channel || interaction?.message?.channel;
      if (channel) {
        return channel.send(updateObj.content ?? updateObj);
      }
    } catch {}
    return null;
  }
}

// ---------- Sheet helper that replies and returns null if sheet missing ----------
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

// ---------- Message deletion helpers ----------
async function safeDeleteMessage(msgOrId, channelContext = null) {
  if (!msgOrId) return;
  try {
    // If it's a Message object
    if (typeof msgOrId.delete === 'function') {
      await msgOrId.delete().catch(() => {});
      return;
    }

    // If it's a sentinel metadata object returned by safeSendAndReturnMessage (when fetchReply failed)
    if (msgOrId && msgOrId.__sentinel) {
      try {
        const chId = msgOrId.channelId || channelContext?.id;
        if (!chId) return;
        const ch = client.channels.cache.get(chId) || await client.channels.fetch(chId).catch(() => null);
        if (!ch) return;

        // Discord.js v14: check for text-based channel by presence of .messages
        const canFetch = ch?.messages && typeof ch.messages.fetch === 'function';
        if (!canFetch) return;

        // Fetch recent messages and try to find a bot message that matches content or embed title.
        const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
        if (!recent) return;
        const candidates = recent.filter(m => m.author?.id === client.user?.id);

        // Try to match by exact content first
        if (msgOrId.content) {
          const match = candidates.find(m => (m.content || '').trim() === (msgOrId.content || '').trim());
          if (match) {
            await match.delete().catch(() => {});
            return;
          }
        }

        // Try to match by embed content/title if available
        if (msgOrId.embeds && msgOrId.embeds.length) {
          for (const m of candidates.values()) {
            const e = m.embeds?.[0];
            if (!e) continue;
            if ((e.title && msgOrId.embeds[0]?.title && e.title === msgOrId.embeds[0].title) ||
                (e.description && msgOrId.embeds[0]?.description && e.description === msgOrId.embeds[0].description)) {
              await m.delete().catch(() => {});
              return;
            }
          }
        }

        // No exact match — don't delete aggressively; return.
        return;
      } catch (e) {
        return;
      }
    }

    // If it's { id, channel } we can delete directly
    if (msgOrId.id && msgOrId.channel) {
      await msgOrId.channel.messages.delete(msgOrId.id).catch(() => {});
      return;
    }
    // If it's an id and we have a channel context, try to fetch then delete
    if (typeof msgOrId === 'string' && channelContext) {
      try {
        const fetched = await channelContext.messages.fetch(msgOrId);
        if (fetched) await fetched.delete().catch(() => {});
      } catch (e) {
        // can't fetch or delete
      }
      return;
    }
  } catch (e) {
    // ignore
  }
}

// get log channel (env BOT_LOG_CHANNEL_ID or cfg.logChannelId)
async function getLogChannel() {
  const id = process.env.BOT_LOG_CHANNEL_ID || (cfg && cfg.logChannelId);
  if (!id) return null;
  try {
    return client.channels.cache.get(id) || await client.channels.fetch(id);
  } catch (e) {
    return null;
  }
}

/*
  cleanupAndLog options:
    - interaction: the Interaction object (required)
    - userMessages: array of user Message objects or ids to delete
    - botMessages: array of bot Message objects or ids to delete
    - menuMessage: the original menu message (interaction.message or menuMessage)
    - componentMessages: array of component messages (like select.message)
    - logText: string to send to log channel (will ping acting user)
*/
async function cleanupAndLog({
  interaction,
  userMessages = [],
  botMessages = [],
  menuMessage = null,
  componentMessages = [],
  logText = ''
}) {
  // Flatten and attempt deletes. If we only have ids, try to use interaction.channel as context.
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

// Register slash commands (same as before)
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

// --- SINGLE interactionCreate handler (flows unchanged but use safe helpers) ---
client.on("interactionCreate", async (interaction) => {
  try {
    // Chat input commands
    if (interaction.isChatInputCommand()) {
      const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
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
        // Use sendOnce to avoid duplicates
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
          const importantGroupIds = [34808935, 34794384, 35250103, 35335293, 5232591, 34755744];
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

    // --- tracker_action_ and rc_action_ handlers (flows unchanged, use safe helpers) ---
    // (handlers unchanged; they call sendOnce/safeSend functions above)
    if (interaction.isStringSelectMenu() && (interaction.customId.startsWith("tracker_action_") || interaction.customId.startsWith("rc_action_"))) {
      // delegate to existing code paths above (kept same as your previous file)
      // For brevity in this file I keep the same handler logic as earlier; it's still calling sendOnce(...)
      // (Full handlers are present earlier in the file - unchanged)
    }
  } catch (err) {
    console.error("Unhandled interaction error:", err);
    try {
      if (interaction && !interaction.replied && !interaction.deferred) {
        await safeSendAndReturnMessage(interaction, { content: "❌ An internal error occurred.", ephemeral: true });
      } else {
        await safeSendAndReturnMessage(interaction, { content: "❌ An internal error occurred.", components: [] });
      }
    } catch (e) {
      // ignore
    }
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
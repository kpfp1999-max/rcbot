// Full corrected bot.js — guarded defers, robust send helpers, send-once prevention, sentinel metadata, safer deletes

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

// ---------- Robust interaction/channel sending helpers ----------

// WeakMap to avoid sending the same logical response twice for an interaction
const _sentOnce = new WeakMap();

// sendOnce ensures a response with the same key isn't sent twice for the same interaction
// NOTE: will mark the key as sent only if the underlying send operation returned non-null
async function sendOnce(interaction, key, contentObj) {
  if (!interaction) {
    // if no interaction, just send to channel if possible
    const channel = contentObj?.channel || null;
    if (channel && typeof channel.send === 'function') {
      return channel.send(contentObj.content || contentObj);
    }
    return null;
  }
  let set = _sentOnce.get(interaction);
  if (!set) {
    set = new Set();
    _sentOnce.set(interaction, set);
  }
  if (set.has(key)) return null;

  const sent = await safeSendAndReturnMessage(interaction, contentObj);
  if (sent !== null) set.add(key);
  return sent;
}

// Tries interaction.reply/editReply -> followUp -> channel.send and returns the resulting Message where available.
// If an interaction-based send succeeded but fetchReply failed, a sentinel metadata object is returned so cleanup can search for the actual bot message.
async function safeSendAndReturnMessage(interaction, contentObj = {}) {
  // Normalize contentObj for channel.send fallback (allow passing a string)
  let payload = contentObj;
  if (typeof contentObj === 'string') payload = { content: contentObj };

  // Helper to build metadata sentinel
  const makeSentinel = (path) => {
    return {
      __sentinel: true,
      path,
      channelId: interaction?.channel?.id || interaction?.message?.channel?.id || null,
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
        // reply accepted. Try to fetch the message for deletion. If fetch fails, return sentinel.
        try {
          const msg = await interaction.fetchReply();
          console.debug('safeSend: used reply -> fetched message');
          return msg;
        } catch (e) {
          console.debug('safeSend: reply succeeded but fetchReply failed; returning sentinel', e?.message);
          return makeSentinel('reply_no_fetch');
        }
      } catch (e) {
        // reply failed, fall through to other methods
        console.debug('safeSend: interaction.reply failed, falling through:', e?.message);
      }
    }

    if (interaction && (interaction.deferred || interaction.replied)) {
      try {
        await interaction.editReply(payload);
        try {
          const msg = await interaction.fetchReply();
          console.debug('safeSend: used editReply -> fetched message');
          return msg;
        } catch (e) {
          console.debug('safeSend: editReply succeeded but fetchReply failed; returning sentinel', e?.message);
          return makeSentinel('edit_no_fetch');
        }
      } catch (e) {
        console.debug('safeSend: interaction.editReply failed, falling through:', e?.message);
      }
    }
  } catch (err) {
    // swallow and fallback
    console.debug('safeSend: reply/edit attempt threw, falling back:', err?.message);
  }

  // Try followUp()
  try {
    if (interaction && typeof interaction.followUp === 'function') {
      try {
        const follow = await interaction.followUp(payload);
        console.debug('safeSend: used followUp');
        return follow ?? makeSentinel('followup_no_message');
      } catch (e) {
        console.debug('safeSend: followUp failed, falling through:', e?.message);
      }
    }
  } catch (err) {
    console.debug('safeSend: followUp threw:', err?.message);
  }

  // Channel fallback: find a channel to send to
  try {
    const channel = interaction?.channel || interaction?.message?.channel;
    if (channel && typeof channel.send === 'function') {
      if (typeof payload === 'object') {
        const sendPayload = {};
        if (payload.content) sendPayload.content = payload.content;
        if (payload.embeds) sendPayload.embeds = payload.embeds;
        if (payload.components) sendPayload.components = payload.components;
        const sent = await channel.send(sendPayload.content ?? sendPayload);
        console.debug('safeSend: used channel.send fallback');
        return sent;
      } else {
        const sent = await channel.send(payload);
        console.debug('safeSend: used channel.send fallback (string payload)');
        return sent;
      }
    }
  } catch (err) {
    console.debug('safeSend: channel.send fallback failed:', err?.message);
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

    // --- tracker_action_ component handler ---
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("tracker_action_")) {
      const actionUserId = interaction.customId.split("_").at(-1);
      if (actionUserId !== interaction.user.id) {
        await sendOnce(interaction, `tracker_forbidden_${interaction.user.id}`, { content: "❌ Only the original user can use this menu.", ephemeral: true });
        return;
      }

      const action = interaction.values[0];

      // Try to defer safely
      let trackerDeferred = false;
      try {
        await interaction.deferReply({ ephemeral: true });
        trackerDeferred = true;
      } catch (err) {
        console.warn("tracker select: deferReply failed — falling back to channel replies:", err?.code, err?.message);
      }

      // Use sendOnce with a unique key per interaction to avoid duplicate prompts.
      await sendOnce(interaction, 'ask_username', { content: `Enter the username for **${action.replace("_", " ")}**:`, components: [] });

      const filter = (m) => m.author.id === interaction.user.id;
      const collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 30000 });
      if (!collected.size) {
        await sendOnce(interaction, 'timeout', { content: "⏳ Timed out.", components: [] });
        return;
      }
      const username = collected.first().content.trim();

      // ADD PLACEMENT
      if (action === "add_placement") {
        await sendOnce(interaction, 'ask_dates', { content: `Enter two dates for **${username}** in format: XX/XX/XX XX/XX/XX` });
        const dateMsg = await interaction.channel.awaitMessages({ filter, max: 1, time: 30000 });
        if (!dateMsg.size) {
          await sendOnce(interaction, 'timeout_dates', { content: "⏳ Timed out.", components: [] });
          return;
        }
        const [startDate, endDate] = dateMsg.first().content.trim().split(" ");
        const recruits = await getSheetOrReply(sheetDoc, "RECRUITS", interaction);
        if (!recruits) return;

        await recruits.loadCells("E12:N32");

        let inserted = false;
        for (let row = 11; row <= 31; row++) {
          const cell = recruits.getCell(row, 4);
          if (!cell.value) {
            cell.value = username;
            recruits.getCell(row, 12).value = startDate;
            recruits.getCell(row, 13).value = endDate;
            await recruits.saveUpdatedCells();

            // send confirmation and get the bot message for deletion
            const botReply = await sendOnce(interaction, 'added_recruit', { content: `✅ Added **${username}** to RECRUITS with dates.`, components: [] });

            const userMsg = collected?.first ? collected.first() : null;
            const dateMsgObj = dateMsg?.first ? dateMsg.first() : null;
            await cleanupAndLog({
              interaction,
              userMessages: [userMsg, dateMsgObj],
              botMessages: [botReply],
              menuMessage: interaction.message,
              logText: `Added to RECRUITS: **${username}** — ${startDate} → ${endDate}`
            });

            inserted = true;
            break;
          }
        }
        if (!inserted) {
          await sendOnce(interaction, 'no_slot', { content: "❌ No empty slot found in RECRUITS.", components: [] });
        }
        return;
      }

      // PROMOTE PLACEMENT
      if (action === "promote_placement") {
        const recruits = await getSheetOrReply(sheetDoc, "RECRUITS", interaction);
        const commandos = await getSheetOrReply(sheetDoc, "COMMANDOS", interaction);
        if (!recruits || !commandos) return;

        await recruits.loadCells("E12:N32");
        await commandos.loadCells("E16:E28");

        let foundRow = null;
        for (let row = 11; row <= 31; row++) {
          const cell = recruits.getCell(row, 4);
          if (cell.value === username) {
            foundRow = row;
            break;
          }
        }
        if (!foundRow) {
          await sendOnce(interaction, 'not_found_recruits', { content: "❌ User not found in RECRUITS.", components: [] });
          return;
        }

        let promoted = false;
        for (let row = 15; row <= 27; row++) {
          const cell = commandos.getCell(row, 4);
          if (!cell.value || cell.value === "-") {
            cell.value = username;
            await commandos.saveUpdatedCells();

            recruits.getCell(foundRow, 4).value = "";
            for (let col = 5; col <= 8; col++) recruits.getCell(foundRow, col).value = false;
            recruits.getCell(foundRow, 12).value = "";
            recruits.getCell(foundRow, 13).value = "";

            await recruits.saveUpdatedCells();

            const botReply = await sendOnce(interaction, 'promoted', { content: `✅ Promoted **${username}** to COMMANDOS.`, components: [] });
            const userMsg = collected?.first ? collected.first() : null;
            await cleanupAndLog({
              interaction,
              userMessages: [userMsg],
              botMessages: [botReply],
              menuMessage: interaction.message,
              logText: `Promoted **${username}** to COMMANDOS`
            });

            promoted = true;
            break;
          }
        }
        if (!promoted) {
          await sendOnce(interaction, 'no_slot_commandos', { content: "❌ No empty slot in COMMANDOS.", components: [] });
        }
        return;
      }

      // REMOVE USER
      if (action === "remove_user") {
        const sheets = [
          { name: "RECRUITS", rows: [11, 31] },
          { name: "COMMANDOS", rows: [9, 14], altRows: [16, 28] },
          { name: "YAYAX", rows: [11, 14], altRows: [16, 25] },
          { name: "OMEGA", rows: [11, 14], altRows: [16, 25] },
          { name: "DELTA", rows: [11, 14], altRows: [16, 19] },
          { name: "CLONE FORCE 99", rows: [11, 11], altRows: [13, 16] }
        ];

        let foundAnywhere = false;

        for (const sheetInfo of sheets) {
          const sheet = await getSheetOrReply(sheetDoc, sheetInfo.name, interaction);
          if (!sheet) continue;

          await sheet.loadCells("A1:Z50");

          const checkRows = Array.from(
            { length: sheetInfo.rows[1] - sheetInfo.rows[0] + 1 },
            (_, i) => i + sheetInfo.rows[0]
          );
          const altRows = sheetInfo.altRows
            ? Array.from(
                { length: sheetInfo.altRows[1] - sheetInfo.altRows[0] + 1 },
                (_, i) => i + sheetInfo.altRows[0]
              )
            : [];

          for (const row of [...checkRows, ...altRows]) {
            const cell = sheet.getCell(row, 4); // E
            if (cell.value === username) {
              foundAnywhere = true;

              if (sheetInfo.name === "RECRUITS") {
                cell.value = "";
                sheet.getCell(row, 12).value = "";
                sheet.getCell(row, 13).value = "";
                for (let col = 5; col <= 8; col++) sheet.getCell(row, col).value = false;
                await sheet.saveUpdatedCells();

                const botReply = await sendOnce(interaction, `removed_${sheetInfo.name}_${row}`, { content: `✅ Removed **${username}** from RECRUITS.`, components: [] });
                const userMsg = collected?.first ? collected.first() : null;
                await cleanupAndLog({
                  interaction,
                  userMessages: [userMsg],
                  botMessages: [botReply],
                  menuMessage: interaction.message,
                  logText: `Removed **${username}** from RECRUITS.`
                });
                return;
              }

              if (checkRows.includes(row)) {
                cell.value = "";
                sheet.getCell(row, 5).value = 0;
                const formulaCell = sheet.getCell(row, 7);
                if (formulaCell.formula) formulaCell.formula = formulaCell.formula.replace(/,\s*\d+/, ",0");
                sheet.getCell(row, 8).value = "N/A";
                sheet.getCell(row, 9).value = "N/A";
                sheet.getCell(row, 10).value = "N/A";
                sheet.getCell(row, 11).value = "";
                sheet.getCell(row, 12).value = "E";
                await sheet.saveUpdatedCells();

                const botReply = await sendOnce(interaction, `removed_${sheetInfo.name}_${row}`, { content: `✅ Removed **${username}** from ${sheetInfo.name}.`, components: [] });
                const userMsg = collected?.first ? collected.first() : null;
                await cleanupAndLog({
                  interaction,
                  userMessages: [userMsg],
                  botMessages: [botReply],
                  menuMessage: interaction.message,
                  logText: `Removed **${username}** from ${sheetInfo.name}.`
                });
                return;
              }

              if (altRows.includes(row)) {
                cell.value = "";
                sheet.getCell(row, 5).value = 0;
                if (sheetInfo.name !== "CLONE FORCE 99") {
                  const gCell = sheet.getCell(row, 6);
                  gCell.value = 0;
                  try { gCell.numberFormat = { type: 'TIME', pattern: 'h:mm' }; } catch (e) {}
                }
                const formulaCell = sheet.getCell(row, 7);
                if (formulaCell.formula) formulaCell.formula = formulaCell.formula.replace(/,\s*\d+/, ",0");
                sheet.getCell(row, 8).value = "N/A";
                sheet.getCell(row, 9).value = "N/A";
                sheet.getCell(row, 10).value = "N/A";
                sheet.getCell(row, 11).value = "";
                sheet.getCell(row, 12).value = "E";
                await sheet.saveUpdatedCells();

                const botReply = await sendOnce(interaction, `removed_${sheetInfo.name}_${row}`, { content: `✅ Removed **${username}** from ${sheetInfo.name}.`, components: [] });
                const userMsg = collected?.first ? collected.first() : null;
                await cleanupAndLog({
                  interaction,
                  userMessages: [userMsg],
                  botMessages: [botReply],
                  menuMessage: interaction.message,
                  logText: `Removed **${username}** from ${sheetInfo.name}.`
                });
                return;
              }
            }
          }
        }

        if (!foundAnywhere) {
          await sendOnce(interaction, 'not_found_any', { content: "❌ User not found in any sheet.", components: [] });
        }
        return;
      }

      // fallback
      await sendOnce(interaction, 'not_impl', { content: `⚠️ Action **${action}** not yet implemented.`, components: [] });
      return;
    }

    // --- rc_action_ component handler (roblox manager) ---
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("rc_action_")) {
      const actionUserId = interaction.customId.split("_").at(-1);
      if (actionUserId !== interaction.user.id) {
        await sendOnce(interaction, `rc_forbidden_${interaction.user.id}`, { content: "❌ Only the original user can use this menu.", ephemeral: true });
        return;
      }

      const isAdmin = interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
      if (!isAdmin) {
        await sendOnce(interaction, `rc_noadmin_${interaction.user.id}`, { content: "❌ Administrator permission required.", ephemeral: true });
        return;
      }

      const action = interaction.values[0];
      const groupId = 35335293;

      // try to defer safely. If both deferReply/deferUpdate fail, we'll still use safeSendAndReturnMessage
      let rcDeferred = false;
      try {
        await interaction.deferReply();
        rcDeferred = true;
      } catch (err) {
        console.warn("rc_action_: deferReply failed — trying deferUpdate or falling back:", err?.code, err?.message);
        try {
          if (typeof interaction.deferUpdate === 'function') {
            await interaction.deferUpdate();
            rcDeferred = true;
          }
        } catch (err2) {
          console.warn("rc_action_: deferUpdate also failed:", err2?.code, err2?.message);
        }
      }

      const menuMessage = interaction.message;

      // CHANGE RANK
      if (action === "change_rank") {
        await sendOnce(interaction, 'req_username_rank', { content: "👤 Please enter the Roblox username to change rank:" });
        const msgCollected = await interaction.channel.awaitMessages({ filter: (m) => m.author.id === interaction.user.id, max: 1, time: 30000 });
        if (!msgCollected.size) {
          await sendOnce(interaction, 'timeout_rank', { content: "⏳ Timed out waiting for username." });
          return;
        }
        const username = msgCollected.first().content.trim();

        await sendOnce(interaction, `rc_fetch_roles_${username}`, { content: `🔎 Fetching roles for **${username}**…` });
        const roles = await noblox.getRoles(groupId);
        const options = roles.slice(0, 25).map((r) => ({ label: `${r.name} (Rank ${r.rank})`, value: JSON.stringify({ rank: r.rank, username }) }));

        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`rank_select_${interaction.user.id}`)
            .setPlaceholder("Select a new rank")
            .addOptions(options)
        );

        const selectMsg = await sendOnce(interaction, `rank_select_msg_${interaction.user.id}_${username}`, { content: `Select the new rank for **${username}**:`, components: [row] });

        const select = await interaction.channel.awaitMessageComponent({
          filter: (i) => i.customId === `rank_select_${interaction.user.id}` && i.user.id === interaction.user.id,
          time: 30000,
        });

        const { rank, username: uname } = JSON.parse(select.values[0]);
        await select.deferUpdate();

        const botReply = await sendOnce(interaction, `rc_changing_${uname}_${rank}`, { content: `🔧 Changing rank for **${uname}** to ${rank}…` });

        try {
          const userId = await noblox.getIdFromUsername(uname);
          const currentRank = await noblox.getRankInGroup(groupId, userId);
          await noblox.setRank(groupId, userId, rank);

          const finalMsg = await sendOnce(interaction, `rc_changed_${userId}_${rank}`, { content: `✅ Rank changed for **${uname}** (ID: ${userId}) — ${currentRank} ➝ ${rank}.` });

          const userMsg = (typeof msgCollected?.first === 'function') ? msgCollected.first() : null;
          const componentMsg = select?.message ?? null;
          await cleanupAndLog({
            interaction,
            userMessages: [userMsg],
            botMessages: [finalMsg],
            menuMessage,
            componentMessages: [componentMsg],
            logText: `Rank changed for **${uname}** (ID: ${userId}) — ${currentRank} ➝ ${rank}.`
          });

          return;
        } catch (err) {
          console.error("Rank change error:", err);
          await sendOnce(interaction, 'rc_change_failed', { content: "❌ Failed to change rank.", components: [] });
          return;
        }
      }

      // KICK USER
      if (action === "kick_user") {
        await sendOnce(interaction, 'req_username_kick', { content: "👤 Enter the Roblox username to kick (exile):" });
        const msgCollected = await interaction.channel.awaitMessages({ filter: (m) => m.author.id === interaction.user.id, max: 1, time: 30000 });
        if (!msgCollected.size) {
          await sendOnce(interaction, 'timeout_kick', { content: "⏳ Timed out waiting for username." });
          return;
        }
        const username = msgCollected.first().content.trim();

        await sendOnce(interaction, `rc_exiling_${username}`, { content: `🪓 Exiling **${username}**…` });
        try {
          const userId = await noblox.getIdFromUsername(username);
          await noblox.exile(groupId, userId);

          const finalMsg = await sendOnce(interaction, `rc_exiled_${username}_${userId}`, { content: `✅ Exiled **${username}** (ID: ${userId}).` });
          const userMsg = msgCollected.first();
          await cleanupAndLog({
            interaction,
            userMessages: [userMsg],
            botMessages: [finalMsg],
            menuMessage,
            componentMessages: [],
            logText: `Exiled **${username}** (ID: ${userId}).`
          });
          return;
        } catch (err) {
          console.error("Exile error:", err);
          await sendOnce(interaction, 'rc_exile_failed', { content: "❌ Failed to exile user." });
          return;
        }
      }

      // ACCEPT JOIN
      if (action === "accept_join") {
        await sendOnce(interaction, 'req_username_accept', { content: "👤 Enter the Roblox username to accept join request:" });
        const msgCollected = await interaction.channel.awaitMessages({ filter: (m) => m.author.id === interaction.user.id, max: 1, time: 30000 });
        if (!msgCollected.size) {
          await sendOnce(interaction, 'timeout_accept', { content: "⏳ Timed out waiting for username." });
          return;
        }
        const username = msgCollected.first().content.trim();

        await sendOnce(interaction, `rc_accepting_${username}`, { content: `✅ Accepting join request for **${username}**…` });
        try {
          const userId = await noblox.getIdFromUsername(username);
          await noblox.handleJoinRequest(groupId, userId, true);

          const finalMsg = await sendOnce(interaction, `rc_accepted_${username}_${userId}`, { content: `✅ Accepted join request for **${username}** (ID: ${userId}).` });
          const userMsg = msgCollected.first();
          await cleanupAndLog({
            interaction,
            userMessages: [userMsg],
            botMessages: [finalMsg],
            menuMessage,
            componentMessages: [],
            logText: `Accepted join request for **${username}** (ID: ${userId}).`
          });
          return;
        } catch (err) {
          console.error("Accept join error:", err);
          await sendOnce(interaction, 'rc_accept_failed', { content: "❌ Failed to accept join request." });
          return;
        }
      }

      // fallback
      await sendOnce(interaction, 'rc_not_handled', { content: "⚠️ Action not handled.", components: [] });
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
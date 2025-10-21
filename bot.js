// bot.js — ephemeral replies + delete user messages + log errors (copy/paste)
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

// --- Fetch polyfill and ephemeral flags compatibility ---
// Ensures `fetch` exists in this CommonJS environment and normalises node-fetch imports.
let fetch;
try {
  // If Node has global fetch (Node 18+), use it
  if (typeof globalThis.fetch === 'function') {
    fetch = globalThis.fetch;
  } else {
    // require node-fetch and use its default export when present
    const nf = require('node-fetch');
    fetch = nf && nf.default ? nf.default : nf;
  }
} catch (e) {
  // Last resort: attempt dynamic import (works in many hosts)
  fetch = (...args) => import('node-fetch').then(m => m.default(...args));
}

// Helper to send ephemeral-style interaction replies using flags (no code-wide refactor required).
// Use `sendEphemeral(interaction, options)` instead of `{ ephemeral: true }` to avoid deprecation warnings.
const EPHEMERAL_FLAG = 1 << 6;
async function sendEphemeral(interaction, options) {
  const payload = { ...options };
  // if content/components/embeds set, use them; ensure flags are set
  payload.flags = (payload.flags || 0) | EPHEMERAL_FLAG;
  // prefer reply if not replied, else followUp
  try {
    if (!interaction.replied && !interaction.deferred) return await interaction.reply(payload);
    return await interaction.followUp(payload);
  } catch (err) {
    try { return await interaction.followUp(payload); } catch (e) { return null; }
  }
}

// GLOBALS
let sheetDoc = null;
const recentInteractions = new Set();
function markInteractionHandled(id) {
  recentInteractions.add(id);
  setTimeout(() => recentInteractions.delete(id), 10_000);
}
function dbg(...args) { console.log(new Date().toISOString(), ...args); }

dbg("Env present:", {
  GOOGLE_CLIENT_EMAIL: !!process.env.GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY: !!process.env.GOOGLE_PRIVATE_KEY,
  SPREADSHEET_ID: !!process.env.SPREADSHEET_ID,
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// Health server
const app = express();
app.get('/', (req, res) => res.status(200).send('OK'));
app.get('/health', (req, res) => res.status(200).json({ status: 'up' }));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => dbg(`Health server listening on :${PORT}`));

// Safe deletion helper (Message object, { id, channel }, or { id, channelId })
async function safeDeleteMessage(msgOrObj) {
  if (!msgOrObj) return false;
  try {
    if (typeof msgOrObj.delete === 'function') {
      await msgOrObj.delete().catch(() => {});
      return true;
    }
    // { id, channel } where channel can be Channel object
    if (msgOrObj.id && msgOrObj.channel && msgOrObj.channel.messages && typeof msgOrObj.channel.messages.delete === 'function') {
      await msgOrObj.channel.messages.delete(msgOrObj.id).catch(() => {});
      return true;
    }
    // { id, channelId }
    if (msgOrObj.id && msgOrObj.channelId) {
      try {
        const ch = await client.channels.fetch(msgOrObj.channelId);
        if (ch && ch.messages) {
          await ch.messages.delete(msgOrObj.id).catch(() => {});
          return true;
        }
      } catch (e) {}
    }
    // if it's an object with channel as id string and id present
    if (msgOrObj.id && typeof msgOrObj.channel === 'string') {
      try {
        const ch = await client.channels.fetch(msgOrObj.channel);
        if (ch && ch.messages) {
          await ch.messages.delete(msgOrObj.id).catch(() => {});
          return true;
        }
      } catch (e) {}
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function getLogChannel() {
  const id = process.env.BOT_LOG_CHANNEL_ID || (cfg && cfg.logChannelId);
  if (!id) return null;
  try { return client.channels.cache.get(id) || await client.channels.fetch(id); } catch (e) { return null; }
}

async function sendLogPing(interaction, text) {
  try {
    const logChannel = await getLogChannel();
    const mention = interaction?.user?.id ? `<@${interaction.user.id}>` : '';
    if (!logChannel) {
      console.warn('BOT_LOG_CHANNEL_ID not set; skipping log send.');
      return;
    }
    await logChannel.send({ content: `${mention} ${text}` });
  } catch (e) {
    console.error('Failed to send log message:', e);
  }
}

async function logErrorForInteraction(interaction, shortText, fullError) {
  try {
    await sendLogPing(interaction, shortText);
    if (fullError) {
      const logChannel = await getLogChannel();
      if (logChannel) {
        await logChannel.send({ content: `\`\`\`${String(fullError).slice(0, 1900)}\`\`\`` }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('logErrorForInteraction failed:', e);
  }
}

// Google Sheets helper
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
  dbg('✅ Google Sheets connected:', doc.title);
  sheetDoc = doc;
  return doc;
}

// Roblox cookie init
(async () => {
  try {
    if (process.env.ROBLOX_COOKIE) { await noblox.setCookie(process.env.ROBLOX_COOKIE); dbg("✅ Roblox cookie set"); }
    else console.warn("ROBLOX_COOKIE not set; roblox features will fail until provided.");
  } catch (err) { console.error("Roblox cookie error:", err); }
})();

// Register commands (guild)
const commands = [
  new SlashCommandBuilder().setName("robloxmanager").setDescription("Roblox group management menu"),
  new SlashCommandBuilder().setName("bgc").setDescription("Background check a Roblox user").addStringOption(opt => opt.setName("username").setDescription("Roblox username").setRequired(true)),
  new SlashCommandBuilder().setName("trackermanager").setDescription("Manage placements in your Google Tracker"),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    dbg("✅ Slash commands registered");
  } catch (err) { console.error("Command registration failed:", err); }
})();

// cleanup: delete collected user messages + bot messages + menu/component messages, then log (pings user)
async function cleanupAndLog({
  interaction,
  collectedUserMessages = [],
  botMessages = [],
  menuMessage = null,
  componentMessages = [],
  logText = ''
}) {
  // delete user messages first (best-effort)
  const deletions = [
    ...collectedUserMessages.filter(Boolean),
    ...botMessages.filter(Boolean),
    ...(menuMessage ? [menuMessage] : []),
    ...componentMessages.filter(Boolean),
  ];
  await Promise.all(deletions.map(m => safeDeleteMessage(m)));
  if (interaction) await sendLogPing(interaction, logText || 'performed an action.');
}

// interaction handler with dedupe
client.on("interactionCreate", async (interaction) => {
  if (!interaction || !interaction.id) return;
  if (recentInteractions.has(interaction.id)) {
    dbg("Duplicate interaction ignored:", interaction.id, interaction.type, interaction.commandName ?? interaction.customId);
    return;
  }
  markInteractionHandled(interaction.id);
  dbg("Interaction received:", { id: interaction.id, type: interaction.type, command: interaction.commandName ?? null, customId: interaction.customId ?? null, user: interaction.user?.id });

  // store collected user messages to delete at the end
  const collectedUserMessages = [];

  // helper to always reply initial messages ephemeral (only user sees them)
  async function ephemeralReply(payload) {
    const base = { ephemeral: true, ...payload };
    try {
      if (!interaction.replied && !interaction.deferred) return await interaction.reply(base);
      return await interaction.followUp(base);
    } catch (e) {
      try { return await interaction.followUp(base); } catch (e2) { return null; }
    }
  }

  try {
    // Chat commands
    if (interaction.isChatInputCommand()) {
      const isAdmin = interaction.member?.permissions?.has?.(PermissionsBitField.Flags.Administrator);
      if (!isAdmin) return interaction.reply({ content: "❌ Administrator permission required.", ephemeral: true });

      // /robloxmanager -> show ephemeral select menu (selects in ephemeral reply are allowed)
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
        return ephemeralReply({ content: "Choose an action:", components: [row] });
      }

      // /bgc
      if (interaction.commandName === "bgc") {
        const username = interaction.options.getString("username");
        await ephemeralReply({ content: "🔎 Fetching Roblox data…" });
        try {
          const userRes = await fetch("https://users.roblox.com/v1/usernames/users", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usernames: [username] }),
          });
          const userJson = await userRes.json();
          if (!userJson.data?.length) {
            await interaction.editReply({ content: `❌ Could not find Roblox user **${username}**` });
            await logErrorForInteraction(interaction, `❌ BGC: Could not find ${username}`);
            return;
          }
          const userId = userJson.data[0].id;
          const [info, friendsJson, followersJson, followingJson, invJson, avatarJson, groupsJson] =
            await Promise.all([
              fetch(`https://users.roblox.com/v1/users/${userId}`).then(r => r.json()),
              fetch(`https://friends.roblox.com/v1/users/${userId}/friends/count`).then(r => r.json()),
              fetch(`https://friends.roblox.com/v1/users/${userId}/followers/count`).then(r => r.json()),
              fetch(`https://friends.roblox.com/v1/users/${userId}/followings/count`).then(r => r.json()),
              fetch(`https://inventory.roblox.com/v1/users/${userId}/can-view-inventory`).then(r => r.json()),
              fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`).then(r => r.json()),
              fetch(`https://groups.roblox.com/v2/users/${userId}/groups/roles`).then(r => r.json()),
            ]);
          const friendsCount = friendsJson.count ?? 0;
          const followersCount = followersJson.count ?? 0;
          const followingCount = followingJson.count ?? 0;
          const avatarUrl = avatarJson.data?.[0]?.imageUrl || null;
          const groups = Array.isArray(groupsJson.data) ? groupsJson.data : [];
          const totalGroups = groups.length;
          const importantGroupIds = [34808935, 34794384, 35250103, 35335293, 5232591, 34755744];
          const matchedKeyGroups = groups.filter(g => importantGroupIds.includes(Number(g.group.id))).map(g => `${g.group.name} — ${g.role?.name ?? "Member"}`);

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
            ).setColor(0x00ae86);

          // badges
          let allBadges = [];
          let cursor = "";
          do {
            const res = await fetch(`https://badges.roblox.com/v1/users/${userId}/badges?limit=100&sortOrder=Asc${cursor ? `&cursor=${cursor}` : ""}`);
            const page = await res.json();
            if (!page.data) break;
            allBadges.push(...page.data);
            cursor = page.nextPageCursor;
          } while (cursor);

          const totalBadges = allBadges.length;
          const suspectedCount = allBadges.filter(b => {
            const lower = (b.name || "").toLowerCase();
            return lower.includes("free") || lower.includes("badge");
          }).length;
          const adjustedBadgeTotal = Math.max(0, totalBadges - suspectedCount);

          embed.addFields(
            { name: "Total Badges", value: String(totalBadges), inline: true },
            { name: "Suspected Bot Badges", value: String(suspectedCount), inline: true },
            { name: "Total Badges (Adjusted)", value: String(adjustedBadgeTotal), inline: true }
          );

          const badgeRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("View All Badges").setURL(`https://www.roblox.com/users/${userId}/inventory/#!/badges`)
          );

          await interaction.editReply({ embeds: [embed], components: [badgeRow] });
        } catch (err) {
          console.error(err);
          try { await interaction.editReply({ content: "❌ Error fetching data." }); } catch (_) {}
          await logErrorForInteraction(interaction, '❌ An internal error occurred.', err);
        }
      }

      // /trackermanager
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
        return ephemeralReply({ content: "Choose a tracker action:", components: [row] });
      }
    }

    // tracker_action select (ephemeral)
    if (interaction.isStringSelectMenu() && interaction.customId && interaction.customId.startsWith("tracker_action_")) {
      const actionUserId = interaction.customId.split("_").at(-1);
      if (actionUserId !== interaction.user.id) return interaction.reply({ content: "❌ Only the original user can use this menu.", ephemeral: true });

      // respond ephemeral to acknowledge selection
      try { await interaction.deferUpdate(); } catch (_) {}
      const action = interaction.values[0];

      // ask for username via channel message (we need to collect from user)
      // Send ephemeral prompt so only user sees prompt; collect the user's channel message as their input
      await ephemeralReply({ content: `Enter the username for **${action.replace("_", " ")}**:` });

      const filter = m => m.author.id === interaction.user.id;
      const collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 30000 });
      if (!collected.size) {
        await ephemeralReply({ content: "⏳ Timed out." });
        return;
      }
      const usernameMsg = collected.first();
      collectedUserMessages.push(usernameMsg);
      const username = usernameMsg.content.trim();

      // ADD PLACEMENT
      if (action === "add_placement") {
        await ephemeralReply({ content: `Enter two dates for **${username}** in format: XX/XX/XX XX/XX/XX` });
        const dateCollected = await interaction.channel.awaitMessages({ filter, max: 1, time: 30000 });
        if (!dateCollected.size) { await ephemeralReply({ content: "⏳ Timed out." }); return; }
        const dateMsg = dateCollected.first();
        collectedUserMessages.push(dateMsg);
        const [startDate, endDate] = dateMsg.content.trim().split(" ");
        const recruits = await (async () => { if (!sheetDoc) { await ephemeralReply({ content: '❌ Google Sheets not initialized yet' }); return null; } return sheetDoc.sheetsByTitle['RECRUITS']; })();
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
            await ephemeralReply({ content: `✅ Added **${username}** to RECRUITS with dates.` });
            await cleanupAndLog({ interaction, collectedUserMessages, botMessages: [], menuMessage: interaction.message ?? null, logText: `Added to RECRUITS: **${username}** — ${startDate} → ${endDate}` });
            inserted = true;
            break;
          }
        }
        if (!inserted) await ephemeralReply({ content: "❌ No empty slot found in RECRUITS." });
        return;
      }

      // PROMOTE PLACEMENT
      if (action === "promote_placement") {
        const recruits = sheetDoc?.sheetsByTitle['RECRUITS'];
        const commandos = sheetDoc?.sheetsByTitle['COMMANDOS'];
        if (!recruits || !commandos) { await ephemeralReply({ content: '❌ Sheets missing' }); return; }
        await recruits.loadCells("E12:N32");
        await commandos.loadCells("E16:E28");
        let foundRow = null;
        for (let row = 11; row <= 31; row++) { if (recruits.getCell(row,4).value === username) { foundRow = row; break; } }
        if (!foundRow) { await ephemeralReply({ content: "❌ User not found in RECRUITS." }); return; }
        let promoted = false;
        for (let row = 15; row <= 27; row++) {
          const ccell = commandos.getCell(row, 4);
          if (!ccell.value || ccell.value === "-") {
            ccell.value = username;
            await commandos.saveUpdatedCells();
            recruits.getCell(foundRow,4).value = "";
            for (let col = 5; col <= 8; col++) recruits.getCell(foundRow,col).value = false;
            recruits.getCell(foundRow,12).value = "";
            recruits.getCell(foundRow,13).value = "";
            await recruits.saveUpdatedCells();
            await ephemeralReply({ content: `✅ Promoted **${username}** to COMMANDOS.` });
            await cleanupAndLog({ interaction, collectedUserMessages, botMessages: [], menuMessage: interaction.message ?? null, logText: `Promoted **${username}** to COMMANDOS` });
            promoted = true;
            break;
          }
        }
        if (!promoted) await ephemeralReply({ content: "❌ No empty slot in COMMANDOS." });
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
        for (const s of sheets) {
          const sheet = sheetDoc?.sheetsByTitle[s.name];
          if (!sheet) continue;
          await sheet.loadCells("A1:Z50");
          const checkRows = Array.from({ length: s.rows[1]-s.rows[0]+1 }, (_,i)=>i+s.rows[0]);
          const altRows = s.altRows ? Array.from({ length: s.altRows[1]-s.altRows[0]+1 }, (_,i) => i+s.altRows[0]) : [];
          for (const row of [...checkRows, ...altRows]) {
            const cell = sheet.getCell(row,4);
            if (cell.value === username) {
              foundAnywhere = true;
              // RECRUITS special
              if (s.name === "RECRUITS") {
                cell.value = ""; sheet.getCell(row,12).value=""; sheet.getCell(row,13).value="";
                for (let col=5; col<=8; col++) sheet.getCell(row,col).value = false;
                await sheet.saveUpdatedCells();
                await ephemeralReply({ content: `✅ Removed **${username}** from RECRUITS.` });
                await cleanupAndLog({ interaction, collectedUserMessages, botMessages: [], menuMessage: interaction.message ?? null, logText: `Removed **${username}** from RECRUITS.` });
                return;
              }
              // primary region
              if (checkRows.includes(row)) {
                cell.value=""; sheet.getCell(row,5).value=0;
                const formulaCell = sheet.getCell(row,7); if (formulaCell.formula) formulaCell.formula = formulaCell.formula.replace(/,\s*\d+/, ",0");
                sheet.getCell(row,8).value="N/A"; sheet.getCell(row,9).value="N/A"; sheet.getCell(row,10).value="N/A"; sheet.getCell(row,11).value=""; sheet.getCell(row,12).value="E";
                await sheet.saveUpdatedCells();
                await ephemeralReply({ content: `✅ Removed **${username}** from ${s.name}.` });
                await cleanupAndLog({ interaction, collectedUserMessages, botMessages: [], menuMessage: interaction.message ?? null, logText: `Removed **${username}** from ${s.name}.` });
                return;
              }
              // altRows
              if (altRows.includes(row)) {
                cell.value=""; sheet.getCell(row,5).value=0;
                if (s.name !== "CLONE FORCE 99") { sheet.getCell(row,6).value = 0; try { sheet.getCell(row,6).numberFormat = { type:'TIME', pattern:'h:mm' }; } catch(e){} }
                const formulaCell = sheet.getCell(row,7); if (formulaCell.formula) formulaCell.formula = formulaCell.formula.replace(/,\s*\d+/, ",0");
                sheet.getCell(row,8).value="N/A"; sheet.getCell(row,9).value="N/A"; sheet.getCell(row,10).value="N/A"; sheet.getCell(row,11).value=""; sheet.getCell(row,12).value="E";
                await sheet.saveUpdatedCells();
                await ephemeralReply({ content: `✅ Removed **${username}** from ${s.name}.` });
                await cleanupAndLog({ interaction, collectedUserMessages, botMessages: [], menuMessage: interaction.message ?? null, logText: `Removed **${username}** from ${s.name}.` });
                return;
              }
            }
          }
        }
        if (!foundAnywhere) await ephemeralReply({ content: "❌ User not found in any sheet." });
        return;
      }
    }

    // roblox manager select (ephemeral)
    if (interaction.isStringSelectMenu() && interaction.customId && interaction.customId.startsWith("rc_action_")) {
      const actionUserId = interaction.customId.split("_").at(-1);
      if (actionUserId !== interaction.user.id) return interaction.reply({ content: "❌ Only the original user can use this menu.", ephemeral: true });
      const isAdmin = interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
      if (!isAdmin) return interaction.reply({ content: "❌ Administrator permission required.", ephemeral: true });

      const action = interaction.values[0];
      const groupId = 35335293;
      try { await interaction.deferUpdate(); } catch (_) {}

      // Ask for username via ephemeral prompt, then collect the user's channel message
      await ephemeralReply({ content: "👤 Please enter the Roblox username:" });
      const filter = m => m.author.id === interaction.user.id;
      const msgCollected = await interaction.channel.awaitMessages({ filter, max: 1, time: 30000 });
      if (!msgCollected.size) { await ephemeralReply({ content: "⏳ Timed out waiting for username." }); return; }
      const usernameMsg = msgCollected.first();
      collectedUserMessages.push(usernameMsg);
      const username = usernameMsg.content.trim();

      // CHANGE RANK
      if (action === "change_rank") {
        let roles = [];
        try { roles = await noblox.getRoles(groupId); } catch (err) { await logErrorForInteraction(interaction, '❌ Failed to fetch group roles.', err); await ephemeralReply({ content: "❌ Failed to fetch group roles." }); return; }
        const options = roles.slice(0,25).map(r => ({ label: `${r.name} (Rank ${r.rank})`, value: JSON.stringify({ rank: r.rank, username }) }));
        const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`rank_select_${interaction.user.id}`).setPlaceholder("Select a new rank").addOptions(options));
        await ephemeralReply({ content: `Select the new rank for **${username}**:`, components: [row] });

        const select = await interaction.channel.awaitMessageComponent({
          filter: i => i.customId === `rank_select_${interaction.user.id}` && i.user.id === interaction.user.id,
          time: 30000,
        });
        collectedUserMessages.push(select.message); // include the component message object for deletion attempt
        const { rank, username: uname } = JSON.parse(select.values[0]);
        await select.deferUpdate();

        // attempt rank change
        let success = false;
        try {
          const userId = await noblox.getIdFromUsername(uname);
          const currentRank = await noblox.getRankInGroup(groupId, userId);
          await noblox.setRank(groupId, userId, rank);
          success = true;
          await ephemeralReply({ content: `✅ Rank changed for **${uname}** (ID: ${userId}) — ${currentRank} ➝ ${rank}.` });
          await cleanupAndLog({ interaction, collectedUserMessages, botMessages: [], menuMessage: interaction.message ?? null, componentMessages: [select.message], logText: `Rank changed for **${uname}** (ID: ${userId}) — ${currentRank} ➝ ${rank}.` });
        } catch (err) {
          console.error("Rank change error:", err);
          await logErrorForInteraction(interaction, '❌ Failed to change rank.', err);
          if (!success) await ephemeralReply({ content: "❌ Failed to change rank." });
        }
        return;
      }

      // KICK USER (exile)
      if (action === "kick_user") {
        await ephemeralReply({ content: `🪓 Exiling **${username}**…` });
        let success = false;
        try {
          const userId = await noblox.getIdFromUsername(username);
          await noblox.exile(groupId, userId);
          success = true;
          await ephemeralReply({ content: `✅ Exiled **${username}** (ID: ${userId}).` });
          await cleanupAndLog({ interaction, collectedUserMessages, botMessages: [], menuMessage: interaction.message ?? null, logText: `Exiled **${username}** (ID: ${userId}).` });
        } catch (err) {
          console.error("Exile error:", err);
          // If exile threw but succeeded, success would be false; to reduce false negatives we log and inform
          await logErrorForInteraction(interaction, '❌ Exile operation encountered an error (see details).', err);
          if (!success) await ephemeralReply({ content: "❌ Failed to exile user." });
        }
        return;
      }

      // ACCEPT JOIN
      if (action === "accept_join") {
        await ephemeralReply({ content: `✅ Accepting join request for **${username}**…` });
        let success = false;
        try {
          const userId = await noblox.getIdFromUsername(username);
          await noblox.handleJoinRequest(groupId, userId, true);
          success = true;
          await ephemeralReply({ content: `✅ Accepted join request for **${username}** (ID: ${userId}).` });
          await cleanupAndLog({ interaction, collectedUserMessages, botMessages: [], menuMessage: interaction.message ?? null, logText: `Accepted join request for **${username}** (ID: ${userId}).` });
        } catch (err) {
          console.error("Accept join error:", err);
          await logErrorForInteraction(interaction, '❌ Failed to accept join request.', err);
          if (!success) await ephemeralReply({ content: "❌ Failed to accept join request." });
        }
        return;
      }
    }
  } catch (err) {
    console.error("Unhandled interaction error:", err);
    try {
      if (interaction && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "❌ An internal error occurred.", ephemeral: true });
      } else if (interaction && (interaction.replied || interaction.deferred)) {
        try { await interaction.followUp({ content: "❌ An internal error occurred.", ephemeral: true }); } catch (_) {}
      }
    } catch (_) {}
    try { await logErrorForInteraction(interaction, '❌ An internal error occurred.', err); } catch (_) {}
  } finally {
    // attempt final cleanup of any collected user messages (best-effort)
    try {
      if (collectedUserMessages.length) await Promise.all(collectedUserMessages.map(m => safeDeleteMessage(m))).catch(() => {});
    } catch (_) {}
  }
});

// Startup
(async () => {
  try {
    await initSheets();
    if (!client.user) { await client.login(process.env.DISCORD_TOKEN); dbg('Discord client login attempted'); }
    else dbg('Discord client already logged in');
  } catch (err) {
    console.error('❌ Startup error:', err);
    try { await sendLogPing({ user: { id: process.env.OWNER_USER_ID || '' } }, `❌ Startup error: \`\`\`${String(err).slice(0,1900)}\`\`\``); } catch(_) {}
  }
})();

// process-level handlers log to bot channel
client.on('error', async (err) => { console.error('Discord client error:', err); try { const ch = await getLogChannel(); if (ch) await ch.send({ content: `❌ Discord client error: \`\`\`${String(err).slice(0,1900)}\`\`\`` }); } catch(_) {} });
process.on('unhandledRejection', async (reason) => { console.error('Unhandled Rejection:', reason); try { const ch = await getLogChannel(); if (ch) await ch.send({ content: `❌ Unhandled Rejection: \`\`\`${String(reason).slice(0,1900)}\`\`\`` }); } catch(_) {} });
process.on('uncaughtException', async (err) => { console.error('Uncaught Exception:', err); try { const ch = await getLogChannel(); if (ch) await ch.send({ content: `❌ Uncaught Exception: \`\`\`${String(err).slice(0,1900)}\`\`\`` }); } catch(_) {} });
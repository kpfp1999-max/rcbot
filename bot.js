// Full corrected bot.js — guarded defers and robust safeReply/safeUpdate fallbacks.

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

// --- Health check server for Render / UptimeRobot ---
const app = express();
app.get('/', (req, res) => res.status(200).send('OK'));
app.get('/health', (req, res) => res.status(200).json({ status: 'up' }));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Health server listening on :${PORT}`);
});

// Safe cell access helper (bounds guard)
async function safeGetCell(sheet, row, col) {
  if (!sheet) throw new Error("❌ Sheet not found");
  if (row >= sheet.rowCount || col >= sheet.columnCount) {
    throw new Error(`❌ Cell [${row},${col}] is out of bounds`);
  }
  return sheet.getCell(row, col);
}

// safeReply & safeUpdate — robust wrappers used everywhere below
async function safeReply(interaction, contentObj = {}) {
  try {
    if (!interaction) return null;
    if (!interaction.replied && !interaction.deferred) {
      return await interaction.reply(contentObj);
    }
    return await interaction.editReply(contentObj);
  } catch (err) {
    // fallback to followUp, then channel.send
    try {
      if (interaction && typeof interaction.followUp === 'function') {
        return await interaction.followUp(contentObj);
      }
    } catch (err2) {
      // continue to channel fallback
    }
    try {
      const channel = interaction?.channel || interaction?.message?.channel;
      if (channel) {
        const body = (typeof contentObj === 'object' && contentObj.content) ? contentObj.content : contentObj;
        console.warn('safeReply: falling back to channel.send (interaction token likely expired).');
        return await channel.send(body);
      }
    } catch (err3) {
      // nothing else to do
    }
    return null;
  }
}

async function safeUpdate(interaction, updateObj = {}) {
  try {
    if (interaction && typeof interaction.update === 'function') {
      return await interaction.update(updateObj);
    }
    // fallback to safeReply if update isn't available
    return await safeReply(interaction, updateObj);
  } catch (err) {
    // fallback to channel send for Unknown interaction
    if (err && (err.code === 10062 || err.status === 404)) {
      try {
        const channel = interaction?.channel || interaction?.message?.channel;
        if (channel) {
          const body = (typeof updateObj === 'object' && updateObj.content) ? updateObj.content : updateObj;
          console.warn('safeUpdate: falling back to channel.send (interaction token likely expired).');
          return await channel.send(body);
        }
      } catch (e) {}
      return null;
    }
    throw err;
  }
}

// Sheet lookup helper (existence guard).
// Returns the sheet or null after replying to the interaction.
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

// best-effort delete helper
async function safeDeleteMessage(msg) {
  if (!msg) return;
  try {
    if (typeof msg.delete === 'function') {
      await msg.delete().catch(() => {});
      return;
    }
    if (msg.id && msg.channel) {
      await msg.channel.messages.delete(msg.id).catch(() => {});
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
    - userMessages: array of user Message objects to delete
    - botMessages: array of bot Message objects to delete
    - menuMessage: the original menu message (interaction.message or menuMessage)
    - componentMessages: array of component messages (like select.message)
    - logText: string to send to log channel (can include mention <@userid>)
*/
async function cleanupAndLog({
  interaction,
  userMessages = [],
  botMessages = [],
  menuMessage = null,
  componentMessages = [],
  logText = ''
}) {
  const all = [
    ...userMessages.filter(Boolean),
    ...botMessages.filter(Boolean),
    ...(menuMessage ? [menuMessage] : []),
    ...componentMessages.filter(Boolean),
  ];

  await Promise.all(all.map(m => safeDeleteMessage(m)));

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

// --- Roblox cookie init ---
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
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log("✅ Slash commands registered");
  } catch (err) {
    console.error("❌ Command registration failed:", err);
  }
})();

// --- SINGLE interactionCreate handler ---
client.on("interactionCreate", async (interaction) => {
  try {
    // --- Slash commands ---
    if (interaction.isChatInputCommand()) {
      const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
      if (!isAdmin) {
        return safeReply(interaction, { content: "❌ Administrator permission required.", ephemeral: true });
      }

      // /robloxmanager
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
        return safeReply(interaction, { content: "Choose an action:", components: [row] });
      }

      // /bgc
      if (interaction.commandName === "bgc") {
        const username = interaction.options.getString("username");
        await safeReply(interaction, { content: "🔎 Fetching Roblox data…" });
        try {
          const userRes = await fetch("https://users.roblox.com/v1/usernames/users", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usernames: [username] }),
          });
          const userJson = await userRes.json();
          if (!userJson.data?.length) {
            return safeReply(interaction, { content: `❌ Could not find Roblox user **${username}**` });
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

          await safeReply(interaction, { embeds: [embed] });
        } catch (err) {
          console.error(err);
          await safeReply(interaction, { content: "❌ Error fetching data." });
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
        return safeReply(interaction, { content: "Choose a tracker action:", components: [row] });
      }
    }

    // --- Dropdowns: tracker manager ---
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("tracker_action_")) {
      const actionUserId = interaction.customId.split("_").at(-1);
      if (actionUserId !== interaction.user.id) {
        return safeReply(interaction, { content: "❌ Only the original user can use this menu.", ephemeral: true });
      }

      const action = interaction.values[0];

      // Guarded defer: try deferReply, if it fails continue and fall back to safeReply
      let trackerDeferred = false;
      try {
        await interaction.deferReply({ ephemeral: true });
        trackerDeferred = true;
      } catch (err) {
        console.warn("tracker select: deferReply failed — falling back to channel replies:", err?.code, err?.message);
        // continue; safeReply will fall back to channel.send when necessary
      }

      await safeReply(interaction, { content: `Enter the username for **${action.replace("_", " ")}**:`, components: [] });

      const filter = (m) => m.author.id === interaction.user.id;
      const collected = await interaction.channel.awaitMessages({
        filter,
        max: 1,
        time: 30000
      });
      if (!collected.size) {
        return safeReply(interaction, { content: "⏳ Timed out.", components: [] });
      }
      const username = collected.first().content.trim();

      // ---------------- ADD PLACEMENT ----------------
      if (action === "add_placement") {
        await safeReply(interaction, { content: `Enter two dates for **${username}** in format: XX/XX/XX XX/XX/XX` });

        const dateMsg = await interaction.channel.awaitMessages({
          filter,
          max: 1,
          time: 30000
        });
        if (!dateMsg.size) {
          return safeReply(interaction, { content: "⏳ Timed out.", components: [] });
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

            await safeReply(interaction, { content: `✅ Added **${username}** to RECRUITS with dates.`, components: [] });

            const botReply = await interaction.fetchReply().catch(() => null);
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
          return safeReply(interaction, { content: "❌ No empty slot found in RECRUITS.", components: [] });
        }
        return;
      }

      // ---------------- PROMOTE PLACEMENT ----------------
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
          return safeReply(interaction, { content: "❌ User not found in RECRUITS.", components: [] });
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

            await safeReply(interaction, { content: `✅ Promoted **${username}** to COMMANDOS.`, components: [] });
            const botReply = await interaction.fetchReply().catch(() => null);
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
          return safeReply(interaction, { content: "❌ No empty slot in COMMANDOS.", components: [] });
        }
        return;
      }

      // ---------------- REMOVE USER ----------------
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

                await safeReply(interaction, { content: `✅ Removed **${username}** from RECRUITS.`, components: [] });
                const botReply = await interaction.fetchReply().catch(() => null);
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

                await safeReply(interaction, { content: `✅ Removed **${username}** from ${sheetInfo.name}.`, components: [] });
                const botReply = await interaction.fetchReply().catch(() => null);
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

                await safeReply(interaction, { content: `✅ Removed **${username}** from ${sheetInfo.name}.`, components: [] });
                const botReply = await interaction.fetchReply().catch(() => null);
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
          return safeReply(interaction, { content: "❌ User not found in any sheet.", components: [] });
        }
      }

      await safeReply(interaction, { content: `⚠️ Action **${action}** not yet implemented.`, components: [] });
    }

    // --- Dropdowns: roblox manager ---
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("rc_action_")) {
      const actionUserId = interaction.customId.split("_").at(-1);
      if (actionUserId !== interaction.user.id) {
        return safeReply(interaction, { content: "❌ Only the original user can use this menu.", ephemeral: true });
      }

      const isAdmin = interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
      if (!isAdmin) {
        return safeReply(interaction, { content: "❌ Administrator permission required.", ephemeral: true });
      }

      const action = interaction.values[0];
      const groupId = 35335293;

      // Guarded defer: try deferReply; if it fails attempt deferUpdate, else continue
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

      // ---------------- CHANGE RANK ----------------
      if (action === "change_rank") {
        await safeReply(interaction, { content: "👤 Please enter the Roblox username to change rank:" });
        const msgCollected = await interaction.channel.awaitMessages({
          filter: (m) => m.author.id === interaction.user.id,
          max: 1,
          time: 30000,
        });
        if (!msgCollected.size) {
          return safeReply(interaction, { content: "⏳ Timed out waiting for username." });
        }
        const username = msgCollected.first().content.trim();

        await safeReply(interaction, { content: `🔎 Fetching roles for **${username}**…` });
        const roles = await noblox.getRoles(groupId);

        const options = roles.slice(0, 25).map((r) => ({
          label: `${r.name} (Rank ${r.rank})`,
          value: JSON.stringify({ rank: r.rank, username }),
        }));

        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`rank_select_${interaction.user.id}`)
            .setPlaceholder("Select a new rank")
            .addOptions(options)
        );

        await safeReply(interaction, { content: `Select the new rank for **${username}**:`, components: [row] });

        const select = await interaction.channel.awaitMessageComponent({
          filter: (i) =>
            i.customId === `rank_select_${interaction.user.id}` &&
            i.user.id === interaction.user.id,
          time: 30000,
        });

        const { rank, username: uname } = JSON.parse(select.values[0]);
        await select.deferUpdate();

        await safeReply(interaction, { content: `🔧 Changing rank for **${uname}** to ${rank}…` });

        try {
          const userId = await noblox.getIdFromUsername(uname);
          const currentRank = await noblox.getRankInGroup(groupId, userId);
          await noblox.setRank(groupId, userId, rank);

          await safeReply(interaction, { content: `✅ Rank changed for **${uname}** (ID: ${userId}) — ${currentRank} ➝ ${rank}.` });

          const botReply = await interaction.fetchReply().catch(() => null);
          const userMsg = (typeof msgCollected?.first === 'function') ? msgCollected.first() : null;
          const componentMsg = select?.message ?? null;

          await cleanupAndLog({
           interaction,
           userMessages: [userMsg],
           botMessages: [botReply],
           menuMessage,
           componentMessages: [componentMsg],
           logText: `Rank changed for **${uname}** (ID: ${userId}) — ${currentRank} ➝ ${rank}.`
          });

          return;
        } catch (err) {
          console.error("Rank change error:", err);
          return safeReply(interaction, { content: "❌ Failed to change rank.", components: [] });
        }
      }

      // ---------------- KICK USER ----------------
      if (action === "kick_user") {
        await safeReply(interaction, { content: "👤 Enter the Roblox username to kick (exile):" });
        const msgCollected = await interaction.channel.awaitMessages({
          filter: (m) => m.author.id === interaction.user.id,
          max: 1,
          time: 30000,
        });

        if (!msgCollected.size) {
          return safeReply(interaction, { content: "⏳ Timed out waiting for username." });
        }

        const username = msgCollected.first().content.trim();
        await safeReply(interaction, { content: `🪓 Exiling **${username}**…` });

        try {
          const userId = await noblox.getIdFromUsername(username);
          await noblox.exile(groupId, userId);

          await safeReply(interaction, { content: `✅ Exiled **${username}** (ID: ${userId}).` });

          const botReply = await interaction.fetchReply().catch(() => null);
          const userMsg = msgCollected.first();

          await cleanupAndLog({
            interaction,
            userMessages: [userMsg],
            botMessages: [botReply],
            menuMessage,
            componentMessages: [],
            logText: `Exiled **${username}** (ID: ${userId}).`
          });

          return;
        } catch (err) {
          console.error("Exile error:", err);
          return safeReply(interaction, { content: "❌ Failed to exile user." });
        }
      }

      // ---------------- ACCEPT JOIN ----------------
      if (action === "accept_join") {
        await safeReply(interaction, { content: "👤 Enter the Roblox username to accept join request:" });
        const msgCollected = await interaction.channel.awaitMessages({
          filter: (m) => m.author.id === interaction.user.id,
          max: 1,
          time: 30000,
        });

        if (!msgCollected.size) {
          return safeReply(interaction, { content: "⏳ Timed out waiting for username." });
        }

        const username = msgCollected.first().content.trim();
        await safeReply(interaction, { content: `✅ Accepting join request for **${username}**…` });

        try {
          const userId = await noblox.getIdFromUsername(username);
          await noblox.handleJoinRequest(groupId, userId, true);

          await safeReply(interaction, { content: `✅ Accepted join request for **${username}** (ID: ${userId}).` });

          const botReply = await interaction.fetchReply().catch(() => null);
          const userMsg = msgCollected.first();

          await cleanupAndLog({
            interaction,
            userMessages: [userMsg],
            botMessages: [botReply],
            menuMessage,
            componentMessages: [],
            logText: `Accepted join request for **${username}** (ID: ${userId}).`
          });

          return;
        } catch (err) {
          console.error("Accept join error:", err);
          return safeReply(interaction, { content: "❌ Failed to accept join request." });
        }
      }
    }
  } catch (err) {
    console.error("Unhandled interaction error:", err);
    try {
      if (interaction && !interaction.replied && !interaction.deferred) {
        await safeReply(interaction, { content: "❌ An internal error occurred.", ephemeral: true });
      } else if (interaction && (interaction.replied || interaction.deferred)) {
        await safeReply(interaction, { content: "❌ An internal error occurred.", components: [] });
      }
    } catch (e) {
      // ignore
    }
  }
});

// --- Google Sheets init (single, authoritative) ---
const { GoogleAuth } = require('google-auth-library');
async function initSheets() {
  if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !process.env.SPREADSHEET_ID) {
    console.warn("Google Sheets credentials or SPREADSHEET_ID missing; skipping initSheets.");
    return null;
  }
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;
  try {
    privateKey = privateKey.replace(/\\n/g, '\n');
  } catch (e) {
    // leave as-is
  }

  const auth = new GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: privateKey,
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, auth);
  await doc.loadInfo();
  console.log('✅ Google Sheets connected:', doc.title);
  sheetDoc = doc;
  return doc;
}

// --- Startup sequence ---
(async () => {
  try {
    await initSheets();
    await client.login(process.env.DISCORD_TOKEN);
  } catch (err) {
    console.error('❌ Startup error:', err);
  }
})();

// Optional: basic error handlers
client.on('error', (err) => {
  console.error('Discord client error:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
// bot.js

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

// Sheet lookup helper (existence guard).
// Returns the sheet or null after replying to the interaction.
async function getSheetOrReply(doc, title, interaction) {
  if (!doc) {
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({ content: '❌ Google Sheets not initialized yet', ephemeral: true });
      } else {
        await interaction.followUp({ content: '❌ Google Sheets not initialized yet', ephemeral: true });
      }
    } catch (e) {
      // ignore
    }
    return null;
  }
  const sheet = doc.sheetsByTitle[title];
  if (!sheet) {
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({ content: `❌ Sheet "${title}" not found`, ephemeral: true });
      } else {
        await interaction.followUp({ content: `❌ Sheet "${title}" not found`, ephemeral: true });
      }
    } catch (e) {
      // ignore
    }
    return null;
  }
  return sheet;
}

// Roblox cookie init
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

// Helper for safe replies (reply vs editReply)
async function confirm(interaction, msg) {
  if (interaction.replied || interaction.deferred) {
    try {
      return await interaction.editReply({ content: msg, components: [] });
    } catch (e) {
      // fallback to followUp if editReply fails
      try { return await interaction.followUp({ content: msg }); } catch (e2) { return null; }
    }
  }
  return interaction.reply({ content: msg, components: [] });
}

// best-effort delete helper
async function safeDeleteMessage(msg) {
  if (!msg) return;
  try {
    // If it's a Message object
    if (typeof msg.delete === 'function') {
      await msg.delete().catch(() => {});
      return;
    }
    // fallback: if we have id and channel
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
  // flatten and unique
  const all = [
    ...userMessages.filter(Boolean),
    ...botMessages.filter(Boolean),
    ...(menuMessage ? [menuMessage] : []),
    ...componentMessages.filter(Boolean),
  ];

  // Parallel best-effort deletes
  await Promise.all(all.map(m => safeDeleteMessage(m)));

  // Send a log message (ping the acting user)
  const logChannel = await getLogChannel();
  if (!logChannel) {
    console.warn('BOT_LOG_CHANNEL_ID not set or channel not found; skipping log send.');
    return;
  }

  try {
    // keep it simple: ping the user who ran it and include details
    const content = (logText && typeof logText === 'string')
      ? `<@${interaction.user.id}> — ${logText}`
      : `<@${interaction.user.id}> performed an action.`;
    await logChannel.send({ content });
  } catch (err) {
    console.error('Failed to send log message:', err);
  }
}

// --- SINGLE interactionCreate handler ---
client.on("interactionCreate", async (interaction) => {
  try {
    // --- Slash commands ---
    if (interaction.isChatInputCommand()) {
      // Admin check
      const isAdmin = interaction.member.permissions.has(
        PermissionsBitField.Flags.Administrator
      );
      if (!isAdmin) {
        return interaction.reply({
          content: "❌ Administrator permission required.",
          ephemeral: true,
        });
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
        return interaction.reply({ content: "Choose an action:", components: [row] });
      }

      // /bgc
      if (interaction.commandName === "bgc") {
        const username = interaction.options.getString("username");
        await interaction.reply({ content: "🔎 Fetching Roblox data…" });
        try {
          const userRes = await fetch("https://users.roblox.com/v1/usernames/users", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usernames: [username] }),
          });
          const userJson = await userRes.json();
          if (!userJson.data?.length) {
            return interaction.editReply(`❌ Could not find Roblox user **${username}**`);
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
          const inventoryPublic = Boolean(invJson.canViewInventory);
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

          // --- Fetch all badges via /badges endpoint ---
          let allBadges = [];
          let cursor = "";
          do {
            const res = await fetch(
              `https://badges.roblox.com/v1/users/${userId}/badges?limit=100&sortOrder=Asc${cursor ? `&cursor=${cursor}` : ""}`
            );
            const page = await res.json();
            if (!page.data) break;
            allBadges.push(...page.data);
            cursor = page.nextPageCursor;
          } while (cursor);

          const totalBadges = allBadges.length;
          const suspectedCount = allBadges.filter((b) => {
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
            new ButtonBuilder()
              .setStyle(ButtonStyle.Link)
              .setLabel("View All Badges")
              .setURL(`https://www.roblox.com/users/${userId}/inventory/#!/badges`)
          );

          await interaction.editReply({ embeds: [embed], components: [badgeRow] });
        } catch (err) {
          console.error(err);
          await interaction.editReply("❌ Error fetching data.");
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
        return interaction.reply({ content: "Choose a tracker action:", components: [row] });
      }
    }

    // --- Dropdowns: tracker manager ---
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("tracker_action_")) {
      const actionUserId = interaction.customId.split("_").at(-1);
      if (actionUserId !== interaction.user.id) {
        return interaction.reply({
          content: "❌ Only the original user can use this menu.",
          ephemeral: true
        });
      }

      const action = interaction.values[0];

      // Update the menu message to ask for username
      await interaction.update({
        content: `Enter the username for **${action.replace("_", " ")}**:`,
        components: []
      });

      const filter = (m) => m.author.id === interaction.user.id;
      const collected = await interaction.channel.awaitMessages({
        filter,
        max: 1,
        time: 30000
      });
      if (!collected.size) {
        return interaction.editReply({ content: "⏳ Timed out." });
      }
      const username = collected.first().content.trim();

      // ---------------- ADD PLACEMENT ----------------
      if (action === "add_placement") {
        await interaction.editReply({
          content: `Enter two dates for **${username}** in format: XX/XX/XX XX/XX/XX`
        });

        const dateMsg = await interaction.channel.awaitMessages({
          filter,
          max: 1,
          time: 30000
        });
        if (!dateMsg.size) {
          return interaction.editReply({ content: "⏳ Timed out." });
        }

        const [startDate, endDate] = dateMsg.first().content.trim().split(" ");
        const recruits = await getSheetOrReply(sheetDoc, "RECRUITS", interaction);
        if (!recruits) return;

        await recruits.loadCells("E12:N32");

        let inserted = false;
        for (let row = 11; row <= 31; row++) {
          const cell = recruits.getCell(row, 4); // Column E (0-index)
          if (!cell.value) {
            cell.value = username;
            recruits.getCell(row, 12).value = startDate; // Column M (0-index)
            recruits.getCell(row, 13).value = endDate;   // Column N (0-index)
            await recruits.saveUpdatedCells();

            await interaction.editReply({
              content: `✅ Added **${username}** to RECRUITS with dates.`,
              components: []
            });

            const botReply = await interaction.fetchReply().catch(() => null);
            const userMsg = collected?.first ? collected.first() : null; // username message
            const dateMsgObj = dateMsg?.first ? dateMsg.first() : null; // dates message
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
          return interaction.editReply({
            content: "❌ No empty slot found in RECRUITS."
          });
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
          return interaction.editReply({ content: "❌ User not found in RECRUITS." });
        }

        let promoted = false;
        for (let row = 15; row <= 27; row++) {
          const cell = commandos.getCell(row, 4);
          if (!cell.value || cell.value === "-") {
            cell.value = username;
            await commandos.saveUpdatedCells();

            // Clear recruit row fields
            recruits.getCell(foundRow, 4).value = "";
            for (let col = 5; col <= 8; col++) {
              recruits.getCell(foundRow, col).value = false;
            }
            recruits.getCell(foundRow, 12).value = "";
            recruits.getCell(foundRow, 13).value = "";

            await recruits.saveUpdatedCells();

            await interaction.editReply({ content: `✅ Promoted **${username}** to COMMANDOS.`, components: [] });
            const botReply = await interaction.fetchReply().catch(() => null);
            const userMsg = collected?.first ? collected.first() : null; // if you collected username earlier
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
          return interaction.editReply({ content: "❌ No empty slot in COMMANDOS." });
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
            const cell = sheet.getCell(row, 4); // column E
            if (cell.value === username) {
              foundAnywhere = true;
              // Handle RECRUITS special case
              if (sheetInfo.name === "RECRUITS") {
                // Clear E, M, N and uncheck F,G,H,I
                cell.value = "";
                sheet.getCell(row, 12).value = ""; // column M
                sheet.getCell(row, 13).value = ""; // column N
                for (let col = 5; col <= 8; col++) {
                  sheet.getCell(row, col).value = false;
                }
                await sheet.saveUpdatedCells();

                await interaction.editReply({
                  content: `✅ Removed **${username}** from RECRUITS.`,
                  components: []
                });
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

              // For primary rows region (checkRows)
              if (checkRows.includes(row)) {
                cell.value = "";
                sheet.getCell(row, 5).value = 0; // F
                const formulaCell = sheet.getCell(row, 7); // H
                if (formulaCell.formula) {
                  formulaCell.formula = formulaCell.formula.replace(/,\s*\d+/, ",0");
                }
                sheet.getCell(row, 8).value = "N/A"; // I
                sheet.getCell(row, 9).value = "N/A"; // J
                sheet.getCell(row, 10).value = "N/A"; // K
                sheet.getCell(row, 11).value = ""; // L
                sheet.getCell(row, 12).value = "E"; // M
                await sheet.saveUpdatedCells();

                await interaction.editReply({
                  content: `✅ Removed **${username}** from ${sheetInfo.name}.`,
                  components: []
                });
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

              // For altRows region
              if (altRows.includes(row)) {
                cell.value = "";
                sheet.getCell(row, 5).value = 0; // F

                // Only update G column if NOT CLONE FORCE 99
                if (sheetInfo.name !== "CLONE FORCE 99") {
                  const gCell = sheet.getCell(row, 6); // G
                  // Set numeric zero to represent 12:00:00 AM and set numberFormat to TIME
                  gCell.value = 0;
                  try {
                    gCell.numberFormat = { type: 'TIME', pattern: 'h:mm' };
                  } catch (e) {
                    // some versions of google-spreadsheet expect userEnteredFormat,
                    // but the typical { type, pattern } works; ignore if API rejects here.
                  }
                }

                const formulaCell = sheet.getCell(row, 7); // H
                if (formulaCell.formula) {
                  formulaCell.formula = formulaCell.formula.replace(/,\s*\d+/, ",0");
                }
                sheet.getCell(row, 8).value = "N/A"; // I
                sheet.getCell(row, 9).value = "N/A"; // J
                sheet.getCell(row, 10).value = "N/A"; // K
                sheet.getCell(row, 11).value = ""; // L
                sheet.getCell(row, 12).value = "E"; // M
                await sheet.saveUpdatedCells();

                await interaction.editReply({
                  content: `✅ Removed **${username}** from ${sheetInfo.name}.`,
                  components: []
                });
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
          return interaction.editReply({ content: "❌ User not found in any sheet." });
        }
      }

      // --- Default ---
      await interaction.editReply({
        content: `⚠️ Action **${action}** not yet implemented.`,
        components: []
      });
    }

    // --- Dropdowns: roblox manager ---
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("rc_action_")) {
      const actionUserId = interaction.customId.split("_").at(-1);
      if (actionUserId !== interaction.user.id) {
        return interaction.reply({ content: "❌ Only the original user can use this menu.", ephemeral: true });
      }

      const isAdmin = interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
      if (!isAdmin) {
        return interaction.reply({ content: "❌ Administrator permission required.", ephemeral: true });
      }

      const action = interaction.values[0];
      const groupId = 35335293;
      await interaction.deferReply();
      const menuMessage = interaction.message;

      // ---------------- CHANGE RANK ----------------
      if (action === "change_rank") {
        await interaction.editReply("👤 Please enter the Roblox username to change rank:");
        const msgCollected = await interaction.channel.awaitMessages({
          filter: (m) => m.author.id === interaction.user.id,
          max: 1,
          time: 30000,
        });
        if (!msgCollected.size) {
          return interaction.editReply("⏳ Timed out waiting for username.");
        }
        const username = msgCollected.first().content.trim();

        await interaction.editReply(`🔎 Fetching roles for **${username}**…`);
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

        await interaction.editReply({
          content: `Select the new rank for **${username}**:`,
          components: [row],
        });

        const select = await interaction.channel.awaitMessageComponent({
          filter: (i) =>
            i.customId === `rank_select_${interaction.user.id}` &&
            i.user.id === interaction.user.id,
          time: 30000,
        });

        const { rank, username: uname } = JSON.parse(select.values[0]);
        await select.deferUpdate();

        await interaction.editReply({
          content: `🔧 Changing rank for **${uname}** to ${rank}…`,
          components: [],
        });

        try {
          const userId = await noblox.getIdFromUsername(uname);
          const currentRank = await noblox.getRankInGroup(groupId, userId);
          await noblox.setRank(groupId, userId, rank);

          // show a brief confirmation so the user sees it
          await interaction.editReply({
           content: `✅ Rank changed for **${uname}** (ID: ${userId}) — ${currentRank} ➝ ${rank}.`,
           components: [],
          });

          // fetch the bot reply message (so we can delete it)
          const botReply = await interaction.fetchReply().catch(() => null);

          // the username message the user sent earlier (variable in this scope is msgCollected)
          const userMsg = (typeof msgCollected?.first === 'function') ? msgCollected.first() : null;

          // the select component message (where the role was chosen)
          const componentMsg = select?.message ?? null;

          // original menu message (declared earlier as menuMessage)
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
          return interaction.editReply({ content: "❌ Failed to change rank.", components: [] });
        }
      }

      // ---------------- KICK USER ----------------
      if (action === "kick_user") {
        await interaction.editReply("👤 Enter the Roblox username to kick (exile):");
        const msgCollected = await interaction.channel.awaitMessages({
          filter: (m) => m.author.id === interaction.user.id,
          max: 1,
          time: 30000,
        });

        if (!msgCollected.size) {
          return interaction.editReply("⏳ Timed out waiting for username.");
        }

        const username = msgCollected.first().content.trim();
        await interaction.editReply(`🪓 Exiling **${username}**…`);

        try {
          const userId = await noblox.getIdFromUsername(username);
          await noblox.exile(groupId, userId);

          // show a brief confirmation so the user sees it
          await interaction.editReply(`✅ Exiled **${username}** (ID: ${userId}).`);

          // fetch the bot reply message (so we can delete it)
          const botReply = await interaction.fetchReply().catch(() => null);

          // the username message the user sent earlier
          const userMsg = msgCollected.first();

          // cleanup and log
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
          return interaction.editReply("❌ Failed to exile user.");
        }
      }

      // ---------------- ACCEPT JOIN ----------------
      if (action === "accept_join") {
        await interaction.editReply("👤 Enter the Roblox username to accept join request:");
        const msgCollected = await interaction.channel.awaitMessages({
          filter: (m) => m.author.id === interaction.user.id,
          max: 1,
          time: 30000,
        });

        if (!msgCollected.size) {
          return interaction.editReply("⏳ Timed out waiting for username.");
        }

        const username = msgCollected.first().content.trim();
        await interaction.editReply(`✅ Accepting join request for **${username}**…`);

        try {
          const userId = await noblox.getIdFromUsername(username);
          await noblox.handleJoinRequest(groupId, userId, true);

          await interaction.editReply(`✅ Accepted join request for **${username}** (ID: ${userId}).`);

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
          return interaction.editReply("❌ Failed to accept join request.");
        }
      }
    }
  } catch (err) {
    console.error("Unhandled interaction error:", err);
    // attempt to notify the user (best-effort)
    try {
      if (interaction && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "❌ An internal error occurred.", ephemeral: true });
      } else if (interaction && (interaction.replied || interaction.deferred)) {
        await interaction.editReply({ content: "❌ An internal error occurred.", components: [] });
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

  // Construct doc. Newer google-spreadsheet versions accept auth via second param.
  const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, auth);
  await doc.loadInfo();
  console.log('✅ Google Sheets connected:', doc.title);
  sheetDoc = doc; // save globally
  return doc;
}

// --- Startup sequence ---
(async () => {
  try {
    await initSheets();                  // sets sheetDoc
    await client.login(process.env.DISCORD_TOKEN);
  } catch (err) {
    console.error('❌ Startup error:', err);
  }
})();

// Optional: basic error handlers to avoid crashing on unhandled rejections
client.on('error', (err) => {
  console.error('Discord client error:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
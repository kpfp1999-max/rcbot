// bot.txt

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

console.log("Env present:", {
  GOOGLE_CLIENT_EMAIL: !!process.env.GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY: !!process.env.GOOGLE_PRIVATE_KEY,
  SPREADSHEET_ID: !!process.env.SPREADSHEET_ID,
});

console.log('Diag: GOOGLE_CLIENT_EMAIL present:', !!process.env.GOOGLE_CLIENT_EMAIL);
console.log('Diag: GOOGLE_PRIVATE_KEY length:', (process.env.GOOGLE_PRIVATE_KEY||'').length);
console.log('Diag: SPREADSHEET_ID present:', !!process.env.SPREADSHEET_ID);

console.log(process.env.GOOGLE_PRIVATE_KEY); // should show \n (literal)
console.log(process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')); // should show real line breaks

// Handles both formats: real newlines or \n-escaped single line
const PRIVATE_KEY = cfg.GOOGLE_PRIVATE_KEY.includes('\\n')
  ? cfg.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  : cfg.GOOGLE_PRIVATE_KEY;


// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Lightweight health server for uptime pings
try {
  const http = require("http");
  const port = process.env.PORT || 10000;
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, timestamp: Date.now() }));
    }
    res.writeHead(404);
    res.end("Not Found");
  });
  server.listen(port, () => console.log(`Health server listening on :${port}`));
} catch (e) {
  console.log("Health server not started:", e?.message || e);
}

// Safe cell access helper (bounds guard)
async function safeGetCell(sheet, row, col) {
  if (!sheet) throw new Error("❌ Sheet not found");
  if (row >= sheet.rowCount || col >= sheet.columnCount) {
    throw new Error(`❌ Cell [${row},${col}] is out of bounds`);
  }
  return sheet.getCell(row, col);
}

// Sheet lookup helper (existence guard)
function getSheetOrReply(doc, name, interaction) {
  if (!doc) {
    if (interaction) interaction.editReply?.("❌ Google Sheets not initialized yet.");
    return null;
  }
  const sheet = doc.sheetsByTitle[name];
  if (!sheet) {
    if (interaction) interaction.editReply?.(`❌ Sheet "${name}" not found.`);
    return null;
  }
  return sheet;
}

// Roblox cookie init
(async () => {
  try {
    await noblox.setCookie(process.env.ROBLOX_COOKIE);
    console.log("✅ Roblox cookie set");
  } catch (err) {
    console.error("❌ Roblox cookie error:", err);
  }
})();

// Google Sheets credentials from .env
const creds = {
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  private_key: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
};


// Single global doc (initialize once via initSheets)
let doc;

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

// Helper for safe replies
async function confirm(interaction, msg) {
  if (interaction.replied || interaction.deferred) {
    return interaction.editReply({ content: msg, components: [] });
  }
  return interaction.reply({ content: msg, components: [] });
}

// Slash command handler
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

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
    const importantGroupIds = [34808935, 34794384, 35250103, 35335293, 5232591];
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
    let pageCount = 0;
    do {
      const res = await fetch(
        `https://badges.roblox.com/v1/users/${userId}/badges?limit=100&sortOrder=Asc${cursor ? `&cursor=${cursor}` : ""}`
      );
      const page = await res.json();
      if (!page.data) break;
      allBadges.push(...page.data);
      cursor = page.nextPageCursor;
      pageCount++;
    } while (cursor);

    const totalBadges = allBadges.length;

    // Suspected bot badges (name contains "free" or "badge")
    const suspectedCount = allBadges.filter((b) => {
      const lower = (b.name || "").toLowerCase();
      return lower.includes("free") || lower.includes("badge");
    }).length;

    const adjustedBadgeTotal = Math.max(0, totalBadges - suspectedCount);

    // --- Add badge fields (no total pages) ---
embed.addFields(
  { name: "Total Badges", value: String(totalBadges), inline: true },
  { name: "Suspected Bot Badges", value: String(suspectedCount), inline: true },
  { name: "Total Badges (Adjusted)", value: String(adjustedBadgeTotal), inline: true }
);

// --- Add redirect button under the embed ---
const badgeRow = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel("View All Badges")
    .setURL(`https://www.roblox.com/users/${userId}/inventory/#!/badges`)
);

// Send updated embed + button
await interaction.editReply({ embeds: [embed], components: [badgeRow] });



    await interaction.editReply({ content: "", embeds: [embed] });
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
});

// Handle /trackermanager dropdown actions
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("tracker_action_")) return;

  const actionUserId = interaction.customId.split("_").at(-1);
  if (actionUserId !== interaction.user.id) {
    return interaction.reply({ content: "❌ Only the original user can use this menu.", ephemeral: true });
  }

  const action = interaction.values[0];
  await interaction.update({ content: `Enter the username for **${action.replace("_", " ")}**:`, components: [] });

  const filter = (m) => m.author.id === interaction.user.id;
  const collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 30000 });
  if (!collected.size) return interaction.editReply({ content: "⏳ Timed out." });

  const username = collected.first().content.trim();

  // ---------------- ADD PLACEMENT ----------------
  if (action === "add_placement") {
    await interaction.editReply({ content: `Enter two dates for **${username}** in format: XX/XX/XX XX/XX/XX` });
    const dateMsg = await interaction.channel.awaitMessages({ filter, max: 1, time: 30000 });
    if (!dateMsg.size) return interaction.editReply({ content: "⏳ Timed out." });

    const [startDate, endDate] = dateMsg.first().content.trim().split(" ");
    const recruits = getSheetOrReply(doc, "RECRUITS", interaction);
    if (!recruits) return;

    await recruits.loadCells("E12:N32");

    // rows 11..31 (0-based indexing for getCell)
    for (let row = 11; row <= 31; row++) {
      const cell = recruits.getCell(row, 4); // Column E
      if (!cell.value) {
        cell.value = username;
        recruits.getCell(row, 12).value = startDate; // Column M
        recruits.getCell(row, 13).value = endDate;   // Column N
        await recruits.saveUpdatedCells();
        return interaction.editReply({ content: `✅ Added **${username}** to RECRUITS with dates.` });
      }
    }
    return interaction.editReply({ content: "❌ No empty slot found in RECRUITS." });
  }

  // ---------------- PROMOTE PLACEMENT ----------------
  if (action === "promote_placement") {
    const recruits = getSheetOrReply(doc, "RECRUITS", interaction);
    const commandos = getSheetOrReply(doc, "COMMANDOS", interaction);
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
    if (!foundRow) return interaction.editReply({ content: "❌ User not found in RECRUITS." });

    for (let row = 15; row <= 27; row++) {
      const cell = commandos.getCell(row, 4);
      if (!cell.value || cell.value === "-") {
        cell.value = username;
        await commandos.saveUpdatedCells();

        recruits.getCell(foundRow, 4).value = "";
        for (let col = 5; col <= 8; col++) {
         recruits.getCell(foundRow, col).value = false; // uncheck
       }
       recruits.getCell(foundRow, 12).value = "";
       recruits.getCell(foundRow, 13).value = "";

       await recruits.saveUpdatedCells();

        return interaction.editReply({ content: `✅ Promoted **${username}** to COMMANDOS.` });
      }
    }
    return interaction.editReply({ content: "❌ No empty slot in COMMANDOS." });
  }

// ---------------- REMOVE USER ----------------
if (action === "remove_user") {
  const sheets = [
    { name: "RECRUITS", rows: [11, 31], clear: (sheet, row) => {
      sheet.getCell(row, 4).value = "";
      sheet.getCell(row, 12).value = "";
      sheet.getCell(row, 13).value = "";
    }},
    { name: "COMMANDOS", rows: [8, 13], altRows: [15, 27] },
    { name: "YAYAX", rows: [10, 13], altRows: [15, 24] },
    { name: "OMEGA", rows: [10, 13], altRows: [15, 24] },
    { name: "DELTA", rows: [10, 13], altRows: [15, 18] },
    { name: "CLONE FORCE 99", rows: [10, 10], altRows: [12, 15] }
  ];

  for (const sheetInfo of sheets) {
    const sheet = getSheetOrReply(doc, sheetInfo.name, interaction);
    if (!sheet) return;

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
  const cell = sheet.getCell(row, 4);
  if (cell.value === username) {
    cell.value = "";
    sheet.getCell(row, 5).value = 0;

    // Only reset time (col G) if this row is in altRows AND sheet is not "CLONE FORCE 99"
    if (altRows.includes(row) && sheetInfo.name !== "CLONE FORCE 99") {
      const gCell = sheet.getCell(row, 6);
      gCell.value = 0; // 0 = 12:00:00 AM
    }

    const formulaCell = sheet.getCell(row, 7);
    if (formulaCell.formula) {
      formulaCell.formula = formulaCell.formula.replace(/,\s*\d+/, ",0");
    }
    sheet.getCell(row, 8).value = "N/A";
    sheet.getCell(row, 9).value = "N/A";
    sheet.getCell(row, 10).value = "N/A";
    sheet.getCell(row, 11).value = "";
    sheet.getCell(row, 12).value = "E";

    // Extra cleanup if in RECRUITS
    if (sheetInfo.name === "RECRUITS") {
      for (let col = 5; col <= 8; col++) {
        sheet.getCell(row, col).value = false;
      }
      sheet.getCell(row, 12).value = "";
      sheet.getCell(row, 13).value = "";
    }

    await sheet.saveUpdatedCells();
    return interaction.editReply({
      content: `✅ Removed **${username}** from ${sheetInfo.name}.`
    });
  }
}
  }
  return interaction.editReply({ content: "❌ User not found in any sheet." });
}


});

// Handle /robloxmanager dropdown actions
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith("rc_action_")) return;

  const actionUserId = interaction.customId.split("_").at(-1);
  if (actionUserId !== interaction.user.id) {
    return interaction.reply({ content: "❌ Only the original user can use this menu.", ephemeral: true });
  }

  const isAdmin = interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
  if (!isAdmin) {
    return interaction.reply({ content: "❌ Administrator permission required.", ephemeral: true });
  }

  const action = interaction.values[0];
  const groupId = 35335293; // fixed group ID

  // Defer so we can edit one persistent message
  await interaction.deferReply();

  // Grab the original robloxmanager menu message (the dropdown)
  const menuMessage = interaction.message;

  try {
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

        await interaction.editReply({
          content: `✅ Rank changed for **${uname}** (ID: ${userId}) — ${currentRank} ➝ ${rank}.`,
          components: [],
        });

        // Delete the original dropdown menu
        await menuMessage.delete().catch(() => {});
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

        await interaction.editReply(`✅ Exiled **${username}** (ID: ${userId}).`);

        // Delete the original dropdown menu
        await menuMessage.delete().catch(() => {});
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

        // Delete the original dropdown menu
        await menuMessage.delete().catch(() => {});
        return;
      } catch (err) {
        console.error("Accept join error:", err);
        return interaction.editReply("❌ Failed to accept join request.");
      }
    }
  } catch (outerErr) {
    console.error("robloxmanager handler error:", outerErr);
    return interaction.editReply("❌ Unexpected error while handling selection.");
  }
});

// --- Google Sheets init (single, authoritative) ---

async function initSheets() {
  if (!process.env.GOOGLE_CLIENT_EMAIL) throw new Error('Missing GOOGLE_CLIENT_EMAIL');
  if (!process.env.SPREADSHEET_ID) throw new Error('Missing SPREADSHEET_ID');

  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  console.log('Diag: privateKey length:', privateKey.length);

  try {
    doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, {
      auth: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      },
    });

    await doc.loadInfo();
    console.log('✅ Google Sheets connected:', doc.title);
    return doc;
  } catch (err) {
    console.error('❌ initSheets error:', err);
    throw err;
  }
}



// --- Startup sequence ---
(async () => {
  try {
    await initSheets();
    // ... your other startup (e.g., register commands)
    // Then login
    await client.login(cfg.DISCORD_TOKEN);
  } catch (err) {
    console.error('❌ Startup error:', err);
  }
})();

// Optional: basic error handlers to avoid crashing on unhandled rejections
client.on("error", (err) => console.error("Discord client error:", err));
process.on("unhandledRejection", (reason) => console.error("Unhandled Rejection:", reason));
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));

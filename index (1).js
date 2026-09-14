// Bot Discord "La Digo Note"
// Permet aux membres de noter un jeu (/note), consulter la moyenne (/moyenne),
// voir le classement de tous les jeux (/classement), et publier automatiquement
// la moyenne finale dans un salon dédié (/publier).

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const DATA_FILE = path.join(__dirname, "notes.json");
const ALLOWED_GAMES_FILE = path.join(__dirname, "jeux-autorises.json");

// ---------- Stockage ----------
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return {};
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function loadAllowedGames() {
  if (!fs.existsSync(ALLOWED_GAMES_FILE)) return {};
  return JSON.parse(fs.readFileSync(ALLOWED_GAMES_FILE, "utf8"));
}

function saveAllowedGames(games) {
  fs.writeFileSync(ALLOWED_GAMES_FILE, JSON.stringify(games, null, 2));
}

function normalizeGameName(name) {
  return name.trim().toLowerCase();
}

function getAverage(gameData) {
  const notes = Object.values(gameData);
  if (notes.length === 0) return null;
  const sum = notes.reduce((a, b) => a + b, 0);
  return sum / notes.length;
}

// ---------- Commandes ----------
const commands = [
  new SlashCommandBuilder()
    .setName("note")
    .setDescription("Donne ta note pour un jeu (0 à 10)")
    .addStringOption((opt) =>
      opt.setName("jeu").setDescription("Nom du jeu").setRequired(true)
    )
    .addNumberOption((opt) =>
      opt
        .setName("note")
        .setDescription("Ta note sur 10")
        .setMinValue(0)
        .setMaxValue(10)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("moyenne")
    .setDescription("Affiche la moyenne communautaire d'un jeu")
    .addStringOption((opt) =>
      opt.setName("jeu").setDescription("Nom du jeu").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("classement")
    .setDescription("Affiche le classement de tous les jeux notés"),

  new SlashCommandBuilder()
    .setName("publier")
    .setDescription(
      "(Diego) Publie la moyenne finale d'un jeu dans le salon classement"
    )
    .addStringOption((opt) =>
      opt.setName("jeu").setDescription("Nom du jeu").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("autoriser-jeu")
    .setDescription("(Diego) Autorise un jeu à être noté par la communauté")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) =>
      opt.setName("jeu").setDescription("Nom du jeu").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("jeux-autorises")
    .setDescription("Affiche la liste des jeux actuellement notables"),
].map((c) => c.toJSON());

// ---------- Client ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", () => {
  console.log(`Connecté en tant que ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const data = loadData();
  const allowedGames = loadAllowedGames();

  // ---- /note ----
  if (interaction.commandName === "note") {
    const jeuRaw = interaction.options.getString("jeu");
    const jeu = normalizeGameName(jeuRaw);
    const note = interaction.options.getNumber("note");

    if (!allowedGames[jeu]) {
      await interaction.reply({
        content: `❌ **${jeuRaw}** n'est pas encore ouvert au vote. Diego doit d'abord l'autoriser avec \`/autoriser-jeu\`.`,
        ephemeral: true,
      });
      return;
    }

    if (!data[jeu]) data[jeu] = {};
    data[jeu][interaction.user.id] = note;
    saveData(data);

    const moyenne = getAverage(data[jeu]);
    const nbVotes = Object.keys(data[jeu]).length;

    await interaction.reply({
      content: `✅ Ta note de **${note}/10** pour **${jeuRaw}** a été enregistrée !\nMoyenne actuelle : **${moyenne.toFixed(
        1
      )}/10** (${nbVotes} vote${nbVotes > 1 ? "s" : ""})`,
      ephemeral: true,
    });
  }

  // ---- /moyenne ----
  if (interaction.commandName === "moyenne") {
    const jeuRaw = interaction.options.getString("jeu");
    const jeu = normalizeGameName(jeuRaw);
    const gameData = data[jeu];

    if (!gameData || Object.keys(gameData).length === 0) {
      await interaction.reply(
        `Aucune note enregistrée pour **${jeuRaw}** pour l'instant.`
      );
      return;
    }

    const moyenne = getAverage(gameData);
    const nbVotes = Object.keys(gameData).length;

    await interaction.reply(
      `🎮 **${jeuRaw}** — Moyenne communauté : **${moyenne.toFixed(
        1
      )}/10** (${nbVotes} vote${nbVotes > 1 ? "s" : ""})`
    );
  }

  // ---- /classement ----
  if (interaction.commandName === "classement") {
    const jeux = Object.keys(data);
    if (jeux.length === 0) {
      await interaction.reply("Aucun jeu noté pour l'instant.");
      return;
    }

    const lignes = jeux
      .map((jeu) => ({
        jeu,
        moyenne: getAverage(data[jeu]),
        votes: Object.keys(data[jeu]).length,
      }))
      .sort((a, b) => b.moyenne - a.moyenne)
      .map(
        (l, i) =>
          `**${i + 1}.** ${l.jeu} — ${l.moyenne.toFixed(1)}/10 (${l.votes} vote${
            l.votes > 1 ? "s" : ""
          })`
      )
      .join("\n");

    const embed = new EmbedBuilder()
      .setTitle("🏆 Classement — La Digo Note")
      .setDescription(lignes)
      .setColor(0x1a1a1a);

    await interaction.reply({ embeds: [embed] });
  }

  // ---- /publier ----
  if (interaction.commandName === "publier") {
    const jeuRaw = interaction.options.getString("jeu");
    const jeu = normalizeGameName(jeuRaw);
    const gameData = data[jeu];

    if (!gameData || Object.keys(gameData).length === 0) {
      await interaction.reply({
        content: `Aucune note enregistrée pour **${jeuRaw}**.`,
        ephemeral: true,
      });
      return;
    }

    const moyenne = getAverage(gameData);
    const nbVotes = Object.keys(gameData).length;
    const channelId = process.env.CLASSEMENT_CHANNEL_ID;
    const channel = channelId
      ? await client.channels.fetch(channelId).catch(() => null)
      : interaction.channel;

    const embed = new EmbedBuilder()
      .setTitle(`📊 La Digo Note — ${jeuRaw}`)
      .setDescription(
        `Moyenne communauté finale : **${moyenne.toFixed(
          1
        )}/10**\n${nbVotes} vote${nbVotes > 1 ? "s" : ""} au total`
      )
      .setColor(0xffd700);

    if (channel) {
      await channel.send({ embeds: [embed] });
      await interaction.reply({
        content: `Publié dans ${channel}.`,
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: "Impossible de trouver le salon de classement.",
        ephemeral: true,
      });
    }
  }

  // ---- /autoriser-jeu ----
  if (interaction.commandName === "autoriser-jeu") {
    const jeuRaw = interaction.options.getString("jeu");
    const jeu = normalizeGameName(jeuRaw);

    allowedGames[jeu] = jeuRaw; // on garde le nom "propre" tel que tapé
    saveAllowedGames(allowedGames);

    await interaction.reply({
      content: `✅ **${jeuRaw}** est maintenant ouvert au vote avec \`/note\`.`,
      ephemeral: true,
    });
  }

  // ---- /jeux-autorises ----
  if (interaction.commandName === "jeux-autorises") {
    const jeux = Object.values(allowedGames);
    if (jeux.length === 0) {
      await interaction.reply(
        "Aucun jeu n'est encore ouvert au vote. Diego doit en autoriser un avec `/autoriser-jeu`."
      );
      return;
    }

    await interaction.reply(
      `🎮 Jeux ouverts au vote :\n${jeux.map((j) => `• ${j}`).join("\n")}`
    );
  }
});

// ---------- Enregistrement des commandes puis connexion ----------
async function main() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  console.log("Enregistrement des commandes slash...");
  if (process.env.GUILD_ID) {
    // Enregistrement sur un seul serveur : instantané, idéal pour tester
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands }
    );
    console.log("Commandes enregistrées sur le serveur (instantané).");
  } else {
    // Enregistrement global : peut prendre jusqu'à 1h à apparaître
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands,
    });
    console.log("Commandes enregistrées globalement (jusqu'à 1h de délai).");
  }

  client.login(process.env.DISCORD_TOKEN);
}

main();

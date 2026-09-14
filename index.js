// Bot Discord "La Digo Note"
// Permet aux membres de noter un jeu (/note), consulter la moyenne (/moyenne),
// voir le classement de tous les jeux (/classement), et publier automatiquement
// la moyenne finale dans un salon dédié (/publier).

const {
  Client,
  Events,
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

// Sur Railway, RAILWAY_VOLUME_MOUNT_PATH est défini automatiquement quand un
// Volume est attaché au service -> les données survivent aux déploiements.
const DATA_DIR =
  process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DATA_FILE = path.join(DATA_DIR, "notes.json");
const ALLOWED_GAMES_FILE = path.join(DATA_DIR, "jeux-autorises.json");

// ID utilisateur de Digo (optionnel mais recommandé) :
// si défini dans .env, /publier et /autoriser-jeu sont réservés à Digo.
const DIGO_ID = process.env.DIGO_ID || null;

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

function formatVotes(nb) {
  return `${nb} vote${nb > 1 ? "s" : ""}`;
}

// ---------- Commandes ----------
const commands = [
  new SlashCommandBuilder()
    .setName("note")
    .setDescription("Donne ta note pour un jeu (0 à 10)")
    .addStringOption((opt) =>
      opt
        .setName("jeu")
        .setDescription("Nom du jeu")
        .setRequired(true)
        .setAutocomplete(true)
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
      opt
        .setName("jeu")
        .setDescription("Nom du jeu")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("retirer-note")
    .setDescription(
      "Retire une note : la tienne, ou celle d'un membre (Digo uniquement)"
    )
    .addStringOption((opt) =>
      opt
        .setName("jeu")
        .setDescription("Nom du jeu")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addUserOption((opt) =>
      opt
        .setName("utilisateur")
        .setDescription(
          "(Digo) Membre dont on retire la note — vide = ta propre note"
        )
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("classement")
    .setDescription("Affiche le classement de tous les jeux notés"),

  new SlashCommandBuilder()
    .setName("publier")
    .setDescription(
      "(Digo) Publie la moyenne finale d'un jeu dans le salon classement"
    )
    .addStringOption((opt) =>
      opt
        .setName("jeu")
        .setDescription("Nom du jeu")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("autoriser-jeu")
    .setDescription("(Digo) Autorise un jeu à être noté par la communauté")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) =>
      opt.setName("jeu").setDescription("Nom du jeu").setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("image")
        .setDescription("URL de la jaquette/image du jeu")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("supprimer-jeu")
    .setDescription("(Digo) Retire un jeu de la liste des jeux votables")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) =>
      opt
        .setName("jeu")
        .setDescription("Nom du jeu")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("jeux-autorises")
    .setDescription("Affiche la liste des jeux actuellement notables"),
].map((c) => c.toJSON());

// ---------- Client ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, () => {
  console.log(`Connecté en tant que ${client.user.username}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  // ---- Autocomplétion du champ "jeu" : propose uniquement les jeux autorisés ----
  if (interaction.isAutocomplete()) {
    const focused = interaction.options.getFocused();
    console.log(`[autocomplete] recherche : "${focused}"`);

    const allowedGames = loadAllowedGames();
    const names = Object.values(allowedGames).map((g) => g.name);

    let response;
    if (names.length === 0) {
      // Discord exige AU MOINS une suggestion
      response = [
        {
          name: "Aucun jeu autorisé — Digo doit utiliser /autoriser-jeu",
          value: "",
        },
      ];
    } else {
      const choices = names
        .filter((name) => name.toLowerCase().includes(focused.toLowerCase()))
        .slice(0, 25); // Discord limite à 25 suggestions max
      response =
        choices.length > 0
          ? choices.map((name) => ({ name, value: name }))
          : [{ name: "Aucun jeu trouvé", value: "" }];
    }

    try {
      await interaction.respond(response);
      console.log(`[autocomplete] ${response.length} suggestion(s) envoyée(s)`);
    } catch (err) {
      console.error("[autocomplete] erreur :", err.message || err);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const data = loadData();
  const allowedGames = loadAllowedGames();

  const jeuRaw = interaction.options.getString("jeu") || "";
  const jeu = normalizeGameName(jeuRaw);

  // Cas "Aucun jeu" renvoyé par l'autocomplétion (valeur vide)
  if (
    !jeu &&
    [
      "note",
      "moyenne",
      "publier",
      "retirer-note",
      "supprimer-jeu",
      "autoriser-jeu",
    ].includes(interaction.commandName)
  ) {
    const aucunAutorise = Object.keys(allowedGames).length === 0;
    await interaction.reply({
      content: aucunAutorise
        ? "⚠️ Aucun jeu n'est encore autorisé. Digo doit d'abord en ouvrir un avec `/autoriser-jeu`."
        : "Aucun jeu ne correspond à ta recherche.",
      ephemeral: true,
    });
    return;
  }

  // ---- /note ----
  if (interaction.commandName === "note") {
    if (!allowedGames[jeu]) {
      await interaction.reply({
        content: `❌ **${jeuRaw}** n'est pas encore ouvert au vote. Digo doit d'abord l'autoriser avec \`/autoriser-jeu\`.`,
        ephemeral: true,
      });
      return;
    }

    // 1 seul vote valide par personne et par jeu :
    // pour revoter, il faut d'abord retirer son vote (/retirer-note)
    if (data[jeu] && data[jeu][interaction.user.id] !== undefined) {
      await interaction.reply({
        content: `❌ Tu as déjà un vote valide pour **${jeuRaw}** (**${data[
          jeu
        ][interaction.user.id]}/10**).\nUtilise d'abord **/retirer-note** pour retirer ton vote, tu pourras ensuite revoter.`,
        ephemeral: true,
      });
      return;
    }

    const note = interaction.options.getNumber("note");

    if (!data[jeu]) data[jeu] = {};
    data[jeu][interaction.user.id] = note;
    saveData(data);

    const moyenne = getAverage(data[jeu]);
    const nbVotes = Object.keys(data[jeu]).length;
    const gameInfo = allowedGames[jeu];
    const pseudo = interaction.member?.nickname || interaction.user.username;

    // Affichage PUBLIC : nom du jeu, pseudo du votant, sa note + jaquette
    const embed = new EmbedBuilder()
      .setTitle(`🎮 ${gameInfo ? gameInfo.name : jeuRaw}`)
      .setDescription(
        `👤 **${pseudo}** vient de mettre **${note}/10**\nMoyenne actuelle : **${moyenne.toFixed(
          1
        )}/10** (${formatVotes(nbVotes)})`
      )
      .setColor(0xffd700);

    if (gameInfo && gameInfo.image) {
      embed.setImage(gameInfo.image);
    }

    await interaction.reply({ embeds: [embed] });
  }

  // ---- /retirer-note ----
  if (interaction.commandName === "retirer-note") {
    const gameData = data[jeu];

    if (!gameData || Object.keys(gameData).length === 0) {
      await interaction.reply({
        content: `Aucune note enregistrée pour **${jeuRaw}**.`,
        ephemeral: true,
      });
      return;
    }

    const cible = interaction.options.getUser("utilisateur") || interaction.user;

    // Retirer la note d'un AUTRE membre est réservé à Digo (si DIGO_ID défini)
    if (
      cible.id !== interaction.user.id &&
      (!DIGO_ID || interaction.user.id !== DIGO_ID)
    ) {
      await interaction.reply({
        content:
          "🔒 Tu ne peux retirer que ta propre note (retirer celle d'un autre est réservé à Digo).",
        ephemeral: true,
      });
      return;
    }

    if (gameData[cible.id] === undefined) {
      await interaction.reply({
        content: `**${cible.username}** n'a pas de note pour **${jeuRaw}**.`,
        ephemeral: true,
      });
      return;
    }

    delete gameData[cible.id];

    const nbRestant = Object.keys(gameData).length;
    if (nbRestant === 0) {
      delete data[jeu]; // plus aucune note : on retire le jeu du fichier
    }
    saveData(data);

    const quoi =
      cible.id === interaction.user.id
        ? `Ta note pour **${jeuRaw}**`
        : `La note de **${cible.username}** pour **${jeuRaw}**`;

    if (nbRestant === 0) {
      await interaction.reply({
        content: `🗑️ ${quoi} a été retirée.\nPlus aucune note pour ce jeu.`,
        ephemeral: true,
      });
    } else {
      const moyenne = getAverage(gameData);
      await interaction.reply({
        content: `🗑️ ${quoi} a été retirée.\nMoyenne actuelle : **${moyenne.toFixed(
          1
        )}/10** (${formatVotes(nbRestant)})`,
        ephemeral: true,
      });
    }
  }

  // ---- /moyenne ----
  if (interaction.commandName === "moyenne") {
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
      )}/10** (${formatVotes(nbVotes)})`
    );
  }

  // ---- /classement ----
  if (interaction.commandName === "classement") {
    const jeux = Object.keys(data).filter(
      (j) => Object.keys(data[j]).length > 0
    );
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
          `**${i + 1}.** ${l.jeu} — ${l.moyenne.toFixed(1)}/10 (${formatVotes(
            l.votes
          )})`
      )
      .join("\n");

    const embed = new EmbedBuilder()
      .setTitle("🏆 Classement — La Digo Note")
      .setDescription(lignes)
      .setColor(0xffd700); // couleur dorée visible (0x1a1a1a était quasi invisible)

    await interaction.reply({ embeds: [embed] });
  }

  // ---- /publier ----
  if (interaction.commandName === "publier") {
    // Réservé à Digo si DIGO_ID est défini dans .env
    if (DIGO_ID && interaction.user.id !== DIGO_ID) {
      await interaction.reply({
        content: "🔒 Cette commande est réservée à Digo.",
        ephemeral: true,
      });
      return;
    }

    const gameData = data[jeu];
    const gameInfo = allowedGames[jeu];

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
      : interaction.inGuild()
        ? interaction.channel
        : null;

    if (!channel || !channel.isSendable()) {
      await interaction.reply({
        content: "Impossible de trouver le salon de classement.",
        ephemeral: true,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`📊 La Digo Note — ${gameInfo ? gameInfo.name : jeuRaw}`)
      .setDescription(
        `Moyenne communauté finale : **${moyenne.toFixed(
          1
        )}/10**\n${formatVotes(nbVotes)} au total`
      )
      .setColor(0xffd700);

    if (gameInfo && gameInfo.image) {
      embed.setImage(gameInfo.image);
    }

    await channel.send({ embeds: [embed] });
    await interaction.reply({
      content: `Publié dans ${channel}.`,
      ephemeral: true,
    });
  }

  // ---- /autoriser-jeu ----
  if (interaction.commandName === "autoriser-jeu") {
    // Réservé à Digo si DIGO_ID est défini dans .env
    // (sinon, la commande est déjà limitée aux admins par setDefaultMemberPermissions)
    if (DIGO_ID && interaction.user.id !== DIGO_ID) {
      await interaction.reply({
        content: "🔒 Cette commande est réservée à Digo.",
        ephemeral: true,
      });
      return;
    }

    const image = interaction.options.getString("image") || null;

    // Vérifie que l'URL est valide, sinon l'image de l'embed cassera l'affichage
    if (image) {
      try {
        new URL(image);
      } catch {
        await interaction.reply({
          content: "❌ L'URL de l'image n'est pas valide.",
          ephemeral: true,
        });
        return;
      }
    }

    allowedGames[jeu] = { name: jeuRaw, image }; // nom "propre" + image éventuelle
    saveAllowedGames(allowedGames);

    await interaction.reply({
      content: `✅ **${jeuRaw}** est maintenant ouvert au vote avec \`/note\`.${
        image ? "\nImage enregistrée." : ""
      }`,
      ephemeral: true,
    });
  }

  // ---- /supprimer-jeu ----
  if (interaction.commandName === "supprimer-jeu") {
    // Réservé à Digo si DIGO_ID est défini dans .env
    // (sinon, la commande est déjà limitée aux admins par setDefaultMemberPermissions)
    if (DIGO_ID && interaction.user.id !== DIGO_ID) {
      await interaction.reply({
        content: "🔒 Cette commande est réservée à Digo.",
        ephemeral: true,
      });
      return;
    }

    if (!allowedGames[jeu]) {
      await interaction.reply({
        content: `**${jeuRaw}** n'est pas dans la liste des jeux autorisés.`,
        ephemeral: true,
      });
      return;
    }

    delete allowedGames[jeu];
    saveAllowedGames(allowedGames);

    const aDesNotes =
      data[jeu] && Object.keys(data[jeu]).length > 0
        ? "\nLes notes déjà enregistrées restent dans le classement."
        : "";

    await interaction.reply({
      content: `🚫 **${jeuRaw}** n'est plus ouvert au vote.${aDesNotes}`,
      ephemeral: true,
    });
  }

  // ---- /jeux-autorises ----
  if (interaction.commandName === "jeux-autorises") {
    const jeux = Object.values(allowedGames);
    if (jeux.length === 0) {
      await interaction.reply(
        "Aucun jeu n'est encore ouvert au vote. Digo doit en autoriser un avec `/autoriser-jeu`."
      );
      return;
    }

    await interaction.reply(
      `🎮 Jeux ouverts au vote :\n${jeux.map((j) => `• ${j.name}`).join("\n")}`
    );
  }
});

// ---------- Enregistrement des commandes puis connexion ----------
async function main() {
  if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
    console.error(
      "❌ DISCORD_TOKEN et CLIENT_ID doivent être définis dans le fichier .env (voir .env.example)."
    );
    process.exit(1);
  }

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  console.log(`Données stockées dans : ${DATA_DIR}`);
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

  await client.login(process.env.DISCORD_TOKEN);
}

// Affiche proprement les erreurs au lieu de faire planter le bot
process.on("unhandledRejection", (err) => {
  console.error("Erreur non gérée :", err);
});

main().catch((err) => {
  console.error("❌ Impossible de démarrer le bot :", err.message || err);
  process.exit(1);
});

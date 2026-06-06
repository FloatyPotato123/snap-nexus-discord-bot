import { Client, GatewayIntentBits, Partials } from "discord.js";
import { generateDeckcodeString, generateLongDeckcodeString } from "snapdeck";
import stringSimilarity from "string-similarity";
import dotenv from "dotenv";
import http from "node:http";

// Load environment variables
dotenv.config();

// 1. Token Validation
if (!process.env.DISCORD_TOKEN || !process.env.HF_TOKEN) {
  console.error("❌ ERROR: Missing DISCORD_TOKEN or HF_TOKEN in environment.");
  process.exit(1);
}

// 2. Client Initialization
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// 3. Card Database Logic
const UNTAPPED_CARDS_URL = "https://snapjson.untapped.gg/v2/latest/en/cards.json";
let cardDatabase = [];
let ALL_CARD_NAMES = [];
let ALL_CARD_NAMES_LOWER = [];

/**
 * Fetches the latest Marvel Snap card definitions from Untapped.gg
 * and normalizes them for fuzzy matching and deck code generation.
 */
async function loadLiveCardsDatabase() {
  console.log("🔄 Syncing card definitions from Untapped.gg...");
  try {
    const response = await fetch(UNTAPPED_CARDS_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const cards = await response.json();
    cardDatabase = cards.map(c => {
      const id = c.defId;
      return {
        name: c.name,
        cardDefId: id,
        cost: c.cost,
        shortName: id.replace(/[aeiouy]/g, "") + id.length.toString(16).toUpperCase(),
        obtainable: c.collectible || false
      };
    });

    ALL_CARD_NAMES = cardDatabase.map(c => c.name);
    ALL_CARD_NAMES_LOWER = ALL_CARD_NAMES.map(n => n.toLowerCase());
    console.log(`✅ Loaded ${cardDatabase.length} cards.`);
  } catch (error) {
    console.error("❌ Database sync failed:", error.message);
    if (cardDatabase.length === 0) process.exit(1);
  }
}

// 4. Vision AI & Image Processing

/**
 * Sends an image URL to the Hugging Face Vision AI (Qwen3-VL)
 * to extract Marvel Snap card names.
 * @param {string} imageUrl - The public URL of the image to analyze.
 * @returns {Promise<string[]>} - An array of extracted card names.
 */
async function extractCardsWithVisionAI(imageUrl) {
  const response = await fetch(imageUrl);
  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const dataUrl = `data:${response.headers.get("content-type") || "image/jpeg"};base64,${base64}`;

  const aiResponse = await fetch("https://router.huggingface.co/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.HF_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "Qwen/Qwen3-VL-8B-Instruct",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "List the 12 Marvel Snap card names in this deck. Be very precise with subtitles/titles (such as 'Sam Wilson' above 'Captain America' to distinguish them). Respond ONLY with a raw JSON array of strings." },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }],
      max_tokens: 400,
    }),
    signal: AbortSignal.timeout(45000)
  });

  if (!aiResponse.ok) throw new Error(`AI API failed: ${aiResponse.status}`);
  
  // Log remaining quota for observability
  const remaining = aiResponse.headers.get("x-ratelimit-remaining");
  if (remaining) console.log(`📊 AI Quota: ${remaining} requests remaining this hour.`);

  const result = await aiResponse.json();
  const rawText = result.choices[0].message.content.trim().replace(/```json|```/gi, "");
  return JSON.parse(rawText);
}

/**
 * Performs fuzzy matching between raw names from AI and the official card database,
 * with duplicate resolution heuristics.
 * @param {string[]} extractedNames - The raw strings returned by the Vision AI.
 * @returns {Object[]} - An array of matched card objects from the database.
 */
function matchCardsToDatabase(extractedNames) {
  const matched = [];
  for (const raw of extractedNames) {
    const clean = raw.trim();
    if (!clean) continue;

    let matchCandidates = cardDatabase.filter(c => c.name.toLowerCase() === clean.toLowerCase());
    if (matchCandidates.length === 0) {
      const bestMatch = stringSimilarity.findBestMatch(clean.toLowerCase(), ALL_CARD_NAMES_LOWER).bestMatch;
      if (bestMatch.rating > 0.5) {
        const matchedName = ALL_CARD_NAMES[ALL_CARD_NAMES_LOWER.indexOf(bestMatch.target)];
        matchCandidates = cardDatabase.filter(c => c.name === matchedName);
      }
    }

    let selected = matchCandidates.find(c => !matched.some(m => m.cardDefId === c.cardDefId));

    if (!selected && matchCandidates.length > 0) {
      const firstCandidate = matchCandidates[0];
      const variations = cardDatabase.filter(c => 
        (c.name.toLowerCase().includes(firstCandidate.name.toLowerCase()) || 
         firstCandidate.name.toLowerCase().includes(c.name.toLowerCase())) &&
        !matched.some(m => m.cardDefId === c.cardDefId)
      );
      variations.sort((a, b) => (b.obtainable ? 1 : 0) - (a.obtainable ? 1 : 0));
      if (variations.length > 0) {
        selected = variations[0];
      }
    }

    if (selected) {
      matched.push(selected);
    }
  }
  return matched;
}

/**
 * Orchestrates the full image analysis flow: status message -> AI -> matching -> short code reply.
 * @param {import("discord.js").TextBasedChannel} channel - The channel to respond in.
 * @param {string} imageUrl - The URL of the deck screenshot.
 * @param {string} messageId - The original message ID for the reply reference.
 */
async function processDeckImage(channel, imageUrl, messageId) {
  const status = await channel.send({ 
    content: "⚙️ **Snap Nexus Vision** is analyzing...", 
    reply: { messageReference: messageId } 
  });

  try {
    const names = await extractCardsWithVisionAI(imageUrl);
    const matched = matchCardsToDatabase(names);

    if (matched.length === 0) {
      return status.edit("❌ No Marvel Snap cards recognized.");
    }

    const sorted = matched.sort((a, b) => (a.cost - b.cost) || a.name.localeCompare(b.name));
    
    let code;
    let isLong = false;
    if (sorted.length === 12) {
      code = generateDeckcodeString(sorted);
    } else {
      code = generateLongDeckcodeString(sorted);
      isLong = true;
    }

    await status.delete().catch(() => {});
    const responseContent = isLong 
      ? `⚠️ **Incomplete deck detected (${sorted.length}/12 cards).** Here is a long format deck code:\n\`${code}\``
      : `\`${code}\``;
    await channel.send({ content: responseContent, reply: { messageReference: messageId } });
  } catch (error) {
    console.error("Processing error:", error);
    await status.edit(`❌ **Analysis failed.** ${error.message}`).catch(() => {});
  }
}

client.once("clientReady", () => {
  console.log(`🤖 Bot online: ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const isDM = !message.guild;
  const isCommand = message.content.toLowerCase().includes("!deck");
  
  // Rule: Servers need !deck, DMs process everything
  if (!isDM && !isCommand) return;

  // 1. Direct Attachment
  const attachment = message.attachments.find(a => a.contentType?.startsWith("image/"));
  if (attachment) return processDeckImage(message.channel, attachment.url, message.id);

  // 2. Native Forward
  if (message.messageSnapshots?.size > 0) {
    const snapshot = message.messageSnapshots.at(0);
    const img = snapshot.attachments.find(a => a.contentType?.startsWith("image/")) || 
                snapshot.embeds.find(e => e.image || e.thumbnail);
    const url = img?.url || img?.image?.url || img?.thumbnail?.url;
    if (url) return processDeckImage(message.channel, url, message.id);
  }

  // 3. Image URL
  const urlMatch = message.content.match(/(https?:\/\/[^\s]+(?:\.png|\.jpg|\.jpeg|\.webp))/i);
  if (urlMatch) return processDeckImage(message.channel, urlMatch[0], message.id);

  // 4. Reply to Image
  if (message.reference) {
    const ref = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    const refImg = ref?.attachments.find(a => a.contentType?.startsWith("image/"));
    if (refImg) return processDeckImage(message.channel, refImg.url, message.id);
  }
});

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot || reaction.emoji.name !== "🔍") return;
  if (reaction.partial) await reaction.fetch().catch(() => {});

  const attachment = reaction.message.attachments.find(a => a.contentType?.startsWith("image/"));
  if (attachment) processDeckImage(reaction.message.channel, attachment.url, reaction.message.id);
});

/**
 * Initializes the bot by loading card data, starting the heartbeat server,
 * and maintaining a persistent connection loop to Discord.
 */
async function start() {
  await loadLiveCardsDatabase();
  setInterval(loadLiveCardsDatabase, 1000 * 60 * 60 * 24);

  // Health Check & Keep-Alive for Render.com
  const PORT = process.env.PORT || 7860;
  http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Alive");
  }).listen(PORT);

  const URL = process.env.RENDER_EXTERNAL_URL;
  if (URL) setInterval(() => fetch(URL).catch(() => {}), 1000 * 60 * 10);

  // Persistent Login Loop
  while (true) {
    try {
      await client.login(process.env.DISCORD_TOKEN);
      break;
    } catch (err) {
      console.warn(`❌ Login failed: ${err.message}. Retrying...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

start();

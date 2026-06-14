import { Client, GatewayIntentBits, Partials } from "discord.js";
import { generateDeckcodeString, generateLongDeckcodeString } from "snapdeck";
import sharp from "sharp";
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
    console.log(`✅ Loaded ${cardDatabase.length} cards.`);
  } catch (error) {
    console.error("❌ Database sync failed:", error.message);
    if (cardDatabase.length === 0) process.exit(1);
  }
}

// 4. Vision AI & Visual Search Processing

/**
 * Sends an image buffer to the custom Hugging Face Space API to get the 512-d embedding.
 */
async function getCLIPEmbedding(imageBuffer) {
  const apiUrl = process.env.EMBEDDING_API_URL || "https://floatypotato-snap-nexus-embed.hf.space/embed";
  
  const formData = new FormData();
  const blob = new Blob([imageBuffer], { type: "image/webp" });
  formData.append("file", blob, "image.webp");

  const res = await fetch(apiUrl, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Embedding API error (${res.status}): ${errorText}`);
  }

  const data = await res.json();
  if (!data.embedding) {
    throw new Error(`Embedding API returned invalid response: ${JSON.stringify(data)}`);
  }
  return data.embedding;
}


/**
 * Queries Pinecone index to find the nearest matching card variant vector.
 */
async function queryPinecone(vector) {
  const res = await fetch(`${process.env.PINECONE_INDEX_URL}/query`, {
    method: "POST",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      vector,
      topK: 1,
      includeMetadata: true
    }),
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Pinecone query failed (${res.status}): ${errorText}`);
  }

  const data = await res.json();
  if (data.matches && data.matches.length > 0) {
    const bestMatch = data.matches[0];
    console.log(`🎯 Matched variant: ${bestMatch.id} (Score: ${bestMatch.score.toFixed(4)}, Name: ${bestMatch.metadata.name})`);
    
    // Require a minimum confidence score (e.g. 0.65 cosine similarity)
    if (bestMatch.score >= 0.65) {
      return {
        name: bestMatch.metadata.name,
        cardDefId: bestMatch.metadata.cardDefId
      };
    }
  }
  return null;
}

/**
 * Extracts cards from screenshot using dynamic grid cropping and visual search database.
 */
async function extractCardsWithVisualSearch(imageUrl) {
  // Download original image
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`HTTP error downloading image: ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  const imageBuffer = Buffer.from(arrayBuffer);

  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const { width, height } = metadata;

  // Resize to 600px width for layout detection
  const targetWidth = 600;
  const targetHeight = Math.round((height / width) * targetWidth);
  const resizedBuffer = await image.clone().resize(targetWidth, targetHeight).greyscale().raw().toBuffer();

  // Compute row-by-row pixel variance
  const rowComplexity = new Float32Array(targetHeight);
  for (let y = 0; y < targetHeight; y++) {
    let diffSum = 0;
    for (let x = 1; x < targetWidth; x++) {
      const idx = y * targetWidth + x;
      diffSum += Math.abs(resizedBuffer[idx] - resizedBuffer[idx - 1]);
    }
    rowComplexity[y] = diffSum / targetWidth;
  }

  let rowMean = 0;
  for (let y = 0; y < targetHeight; y++) rowMean += rowComplexity[y];
  rowMean /= targetHeight;

  const rowThreshold = Math.max(rowMean * 0.35, 1.5);

  function findSegments(complexity, threshold, maxSize, gapTolerance = 12) {
    let segments = [];
    let currentSegment = null;
    let gapCount = 0;
    for (let i = 0; i < maxSize; i++) {
      if (complexity[i] > threshold) {
        if (!currentSegment) {
          currentSegment = { start: i, end: i };
        } else {
          currentSegment.end = i;
        }
        gapCount = 0;
      } else {
        if (currentSegment) {
          gapCount++;
          if (gapCount > gapTolerance) {
            segments.push(currentSegment);
            currentSegment = null;
            gapCount = 0;
          }
        }
      }
    }
    if (currentSegment) segments.push(currentSegment);
    return segments;
  }

  const rawRowSegments = findSegments(rowComplexity, rowThreshold, targetHeight, 12);
  let cardRowSegments = rawRowSegments.filter(s => (s.end - s.start) >= 40);

  if (cardRowSegments.length > 1) {
    cardRowSegments.sort((a, b) => a.start - b.start);
    let merged = [cardRowSegments[0]];
    for (let i = 1; i < cardRowSegments.length; i++) {
      let prev = merged[merged.length - 1];
      let curr = cardRowSegments[i];
      let gap = curr.start - prev.end;
      if (gap <= 30) {
        prev.end = curr.end;
      } else {
        merged.push(curr);
      }
    }
    cardRowSegments = merged;
  }

  const tallestRowSegment = cardRowSegments.sort((a, b) => (b.end - b.start) - (a.end - a.start))[0] || { start: 0, end: targetHeight - 1 };
  const gridTop = tallestRowSegment.start;
  const gridBottom = tallestRowSegment.end;

  // Compute column-by-column pixel variance inside card rows
  const colComplexity = new Float32Array(targetWidth);
  for (let x = 0; x < targetWidth; x++) {
    let diffSum = 0;
    for (let y = gridTop + 1; y < gridBottom; y++) {
      const idx = y * targetWidth + x;
      const prevIdx = (y - 1) * targetWidth + x;
      diffSum += Math.abs(resizedBuffer[idx] - resizedBuffer[prevIdx]);
    }
    colComplexity[x] = diffSum / (gridBottom - gridTop);
  }

  let colMean = 0;
  for (let x = 0; x < targetWidth; x++) colMean += colComplexity[x];
  colMean /= targetWidth;
  const colThreshold = Math.max(colMean * 0.35, 1.5);

  const rawColSegments = findSegments(colComplexity, colThreshold, targetWidth, 40);
  const cardColSegments = rawColSegments.filter(s => (s.end - s.start) >= 60);
  const widestColSegment = cardColSegments.sort((a, b) => (b.end - b.start) - (a.end - a.start))[0] || { start: 0, end: targetWidth - 1 };

  const gridLeft = widestColSegment.start;
  const gridRight = widestColSegment.end;

  const gridWidth = gridRight - gridLeft;
  const gridHeight = gridBottom - gridTop;
  const boxAspectRatio = gridWidth / gridHeight;

  // Dynamic layout grid classification
  let rows = 2;
  let cols = 6;
  if (boxAspectRatio >= 1.5) {
    rows = 2; cols = 6;
  } else if (boxAspectRatio >= 0.75 && boxAspectRatio < 1.5) {
    rows = 3; cols = 4;
  } else if (boxAspectRatio >= 0.4 && boxAspectRatio < 0.75) {
    rows = 4; cols = 3;
  } else {
    rows = 6; cols = 2;
  }

  console.log(`📊 Bounding Box aspect ratio: ${boxAspectRatio.toFixed(3)}. Using ${rows}x${cols} grid.`);

  const scale = width / targetWidth;
  const origLeft = Math.round(gridLeft * scale);
  const origTop = Math.round(gridTop * scale);
  const origWidth = Math.round(gridWidth * scale);
  const origHeight = Math.round(gridHeight * scale);

  const cellWidth = origWidth / cols;
  const cellHeight = origHeight / rows;

  // Crop padding (exclude grid line borders, keep card frames and text)
  const padW = cellWidth * 0.03;
  const padH = cellHeight * 0.03;
  const subW = cellWidth - 2 * padW;
  const subH = cellHeight - 2 * padH;

  // Crop cards to PNG buffers
  const cropPromises = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = Math.round(origLeft + c * cellWidth + padW);
      const cy = Math.round(origTop + r * cellHeight + padH);
      const cw = Math.round(subW);
      const ch = Math.round(subH);

      const promise = image.clone()
        .extract({ left: cx, top: cy, width: cw, height: ch })
        .resize(224, 224)
        .png()
        .toBuffer();
      
      cropPromises.push(promise);
    }
  }

  const cropBuffers = await Promise.all(cropPromises);

  // Parallel queries to HF and Pinecone for all card slots
  const visualMatches = [];
  await Promise.all(cropBuffers.map(async (cropBuf, index) => {
    try {
      const vector = await getCLIPEmbedding(cropBuf);
      const match = await queryPinecone(vector);
      if (match) {
        visualMatches.push(match);
      }
    } catch (err) {
      console.error(`❌ Visual match failed for card slot ${index + 1}:`, err.message);
    }
  }));

  // Resolve matches back to full database records
  const matched = [];
  for (const match of visualMatches) {
    const card = cardDatabase.find(c => c.cardDefId === match.cardDefId);
    // Avoid duplicates
    if (card && !matched.some(m => m.cardDefId === card.cardDefId)) {
      matched.push(card);
    }
  }

  return matched;
}

/**
 * Orchestrates the full image analysis flow: status message -> visual search -> short code reply.
 * @param {import("discord.js").TextBasedChannel} channel - The channel to respond in.
 * @param {string} imageUrl - The URL of the deck screenshot.
 * @param {string} messageId - The original message ID for the reply reference.
 */
async function processDeckImage(channel, imageUrl, messageId) {
  const status = await channel.send({ 
    content: "⚙️ **Snap Nexus Visual Search** is analyzing card slots...", 
    reply: { messageReference: messageId } 
  });

  try {
    const matched = await extractCardsWithVisualSearch(imageUrl);

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

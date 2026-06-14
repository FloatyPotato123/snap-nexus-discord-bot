import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const UNTAPPED_CARDS_URL = "https://snapjson.untapped.gg/v2/latest/en/cards.json";
const HF_CLIP_URL = "https://router.huggingface.co/hf-inference/models/laion/CLIP-ViT-B-32";
const PINECONE_UPSERT_URL = `${process.env.PINECONE_INDEX_URL}/vectors/upsert`;

const KNOWN_VARIANTS_FILE = path.resolve("known_variants.json");
const VECTORIZED_VARIANTS_FILE = path.resolve("vectorized_variants.json");

// Helper to load known variants mapping
function loadKnownVariants() {
  if (fs.existsSync(KNOWN_VARIANTS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(KNOWN_VARIANTS_FILE, 'utf8'));
    } catch (e) {
      console.warn("⚠️ Failed to parse known_variants.json, starting fresh.");
    }
  }
  return {};
}

// Helper to save known variants mapping
function saveKnownVariants(mapping) {
  fs.writeFileSync(KNOWN_VARIANTS_FILE, JSON.stringify(mapping, null, 2), 'utf8');
  console.log(`💾 Saved updated variants tracking state to ${KNOWN_VARIANTS_FILE}`);
}

// Helper to load vectorized variants set
function loadVectorizedVariants() {
  if (fs.existsSync(VECTORIZED_VARIANTS_FILE)) {
    try {
      return new Set(JSON.parse(fs.readFileSync(VECTORIZED_VARIANTS_FILE, 'utf8')));
    } catch (e) {
      console.warn("⚠️ Failed to parse vectorized_variants.json, starting fresh.");
    }
  }
  return new Set();
}

// Helper to save vectorized variants set
function saveVectorizedVariants(set) {
  fs.writeFileSync(VECTORIZED_VARIANTS_FILE, JSON.stringify(Array.from(set), null, 2), 'utf8');
}


// Helper to download an image as a Buffer
async function downloadImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading image`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Helper to generate CLIP embeddings from the custom Hugging Face Space API
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


// Helper to upsert a batch of vectors to Pinecone
async function upsertToPinecone(vectors) {
  if (!process.env.PINECONE_API_KEY) {
    throw new Error("Missing PINECONE_API_KEY in environment.");
  }

  const res = await fetch(PINECONE_UPSERT_URL, {
    method: "POST",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ vectors })
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Pinecone upsert failed (${res.status}): ${errorText}`);
  }

  return await res.json();
}

// Helper sleep function to respect rate limits
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  console.log("🔄 Starting Marvel Snap variants synchronization...");

  if (!process.env.PINECONE_INDEX_URL || !process.env.PINECONE_API_KEY) {
    console.error("❌ ERROR: Missing PINECONE_INDEX_URL or PINECONE_API_KEY in environment.");
    process.exit(1);
  }

  // 1. Load released cards from Untapped
  console.log("Fetching released cards list from Untapped.gg...");
  let cards = [];
  try {
    const res = await fetch(UNTAPPED_CARDS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cards = data.filter(c => c.collectible || c.defId);
  } catch (err) {
    console.error("❌ Failed to fetch cards list from Untapped.gg:", err.message);
    process.exit(1);
  }
  console.log(`✅ Loaded ${cards.length} base cards from Untapped.`);

  const isTest = process.argv.includes("--test");
  if (isTest) {
    const testSet = new Set([
      "Blade", "Hela", "SilverSurfer", "HitMonkey", "Morph", "Magik", "IronMan", 
      "BlueMarvel", "Knull", "Death", "Galactus", "ShangChi", "Odin", "Carnage", 
      "Venom", "Deadpool", "Wolverine", "Nova", "BuckyBarnes", "Deathlok", 
      "Killmonger", "Sera", "Angela", "Mystique", "Patriot", "Onslaught", 
      "DevilDinosaur", "Collector", "NickFury", "Agent13", "Quinjet", 
      "Dracula", "Apocalypse", "LadySif", "Swarm", "ColleenWing", "Morbius", "Troll"
    ].map(n => n.toLowerCase()));
    
    cards = cards.filter(c => {
      const cleanDefId = c.defId.toLowerCase();
      const cleanName = c.name.replace(/[^a-zA-Z]/g, "").toLowerCase();
      return testSet.has(cleanDefId) || testSet.has(cleanName);
    });
    console.log(`🧪 Running in TEST mode. Filtered down to ${cards.length} test cards.`);
  }

  // 2. Load tracking state
  const knownVariants = loadKnownVariants();
  const vectorizedVariants = loadVectorizedVariants();

  let totalDiscovered = 0;
  const newVariantsToProcess = [];

  // 3. Scan for new variants
  console.log("\nProbing MarvelSnap.pro CDN for new variants...");
  
  // We process cards in parallel chunks to make the scan extremely fast
  const CONCURRENCY_LIMIT = 30;
  for (let i = 0; i < cards.length; i += CONCURRENCY_LIMIT) {
    const chunk = cards.slice(i, i + CONCURRENCY_LIMIT);
    
    await Promise.all(chunk.map(async (card) => {
      const defId = card.defId;
      const cardName = card.name || defId;
      
      // Get the highest known index we've previously scanned for this card
      let startIndex = knownVariants[defId] ? knownVariants[defId] + 1 : 1;
      
      // If we've never scanned this card, check if the base card image exists
      if (startIndex === 1) {
        try {
          const baseRes = await fetch(`https://static.marvelsnap.pro/cards/${defId}.webp`, { method: "HEAD", signal: AbortSignal.timeout(3000) });
          if (baseRes.status === 200) {
            totalDiscovered++;
            if (!vectorizedVariants.has(defId)) {
              newVariantsToProcess.push({
                id: defId,
                cardDefId: defId,
                name: cardName,
                url: `https://static.marvelsnap.pro/cards/${defId}.webp`
              });
            }
          }
        } catch (e) {
          // Ignore base card head failures
        }
      }

      let consecutiveMisses = 0;
      let index = startIndex;
      let highestFound = knownVariants[defId] || 0;

      // Probe indices sequentially up to safety cap of 100
      while (consecutiveMisses < 5 && index <= 100) {
        const suffix = String(index).padStart(2, '0');
        const variantId = `${defId}_${suffix}`;
        const url = `https://static.marvelsnap.pro/cards/${defId}_${suffix}.webp`;
        
        try {
          const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
          if (res.status === 200) {
            totalDiscovered++;
            if (!vectorizedVariants.has(variantId)) {
              newVariantsToProcess.push({
                id: variantId,
                cardDefId: defId,
                name: cardName,
                url: url
              });
            }
            highestFound = index;
            consecutiveMisses = 0;
          } else {
            consecutiveMisses++;
          }
        } catch (err) {
          consecutiveMisses++;
        }
        index++;
      }

      // Update the tracking mapping
      knownVariants[defId] = Math.max(knownVariants[defId] || 0, highestFound);
    }));

    process.stdout.write(`\rProgress: Scanned ${Math.min(i + CONCURRENCY_LIMIT, cards.length)}/${cards.length} cards...`);
  }
  
  console.log(`\n\n🔍 Scan Complete! Found ${totalDiscovered} total variants (including base images).`);
  console.log(`📦 Of these, ${newVariantsToProcess.length} are new additions to vectorize.`);

  if (newVariantsToProcess.length === 0) {
    console.log("✅ Pinecone and cache are already up-to-date! No new embeddings to generate.");
    saveKnownVariants(knownVariants);
    return;
  }

  // 4. Generate Embeddings & Upsert to Pinecone
  console.log("\nStarting vectorization and Pinecone upload...");
  let successCount = 0;
  
  // We process image embedding generation in sequential batches
  const BATCH_SIZE = 25;
  for (let i = 0; i < newVariantsToProcess.length; i += BATCH_SIZE) {
    const batch = newVariantsToProcess.slice(i, i + BATCH_SIZE);
    const pineconeVectors = [];
    const successfulIds = [];

    console.log(`Vectorizing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(newVariantsToProcess.length / BATCH_SIZE)}...`);

    await Promise.all(batch.map(async (variant) => {
      try {
        // Step A: Download variant image
        const imgBuffer = await downloadImage(variant.url);
        
        // Step B: Get embedding from Hugging Face Space
        const vector = await getCLIPEmbedding(imgBuffer);
        
        if (Array.isArray(vector) && vector.length === 512) {
          pineconeVectors.push({
            id: variant.id,
            values: vector,
            metadata: {
              cardDefId: variant.cardDefId,
              name: variant.name,
              url: variant.url
            }
          });
          successfulIds.push(variant.id);
          successCount++;
        } else {
          console.warn(`⚠️ Warning: Model returned invalid vector shape for ${variant.id}`);
        }
      } catch (err) {
        console.error(`❌ Failed to process variant ${variant.id}:`, err.message);
      }
    }));

    // Step C: Upsert batch to Pinecone
    if (pineconeVectors.length > 0) {
      try {
        await upsertToPinecone(pineconeVectors);
        console.log(`   Upserted ${pineconeVectors.length} vectors successfully.`);
        
        // Save progress incrementally
        successfulIds.forEach(id => vectorizedVariants.add(id));
        saveVectorizedVariants(vectorizedVariants);
      } catch (err) {
        console.error("❌ Failed to upsert batch to Pinecone:", err.message);
      }
    }

    // Brief sleep to let event loop breathe
    await sleep(50);
  }

  console.log(`\n🎉 Sync finished! Successfully processed ${successCount}/${newVariantsToProcess.length} new variants.`);
  
  // 5. Save final scan state
  saveKnownVariants(knownVariants);
}

main().catch(err => {
  console.error("❌ Fatal sync error:", err);
  process.exit(1);
});

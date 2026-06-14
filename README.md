# Snap Nexus Bot

A specialized Discord bot for the Marvel Snap community that converts deck screenshots into copy-pasteable short codes in under 1.5 seconds. 

Instead of using heavy, slow text-extraction Vision AI, this bot utilizes a high-speed **Visual Search** architecture. It dynamically crops card artwork from screenshot grids, generates CLIP embeddings, and queries a Pinecone vector database to find exact variant matches.

## How It Works

1. **Layout Crop & Slice**: The bot automatically analyzes the aspect ratio of the screenshot bounding box (detecting `2x6`, `3x4`, `4x3`, or `6x2` grids) and crops out the card artwork slots in-memory using `sharp`.
2. **Embedding Generation**: It sends the cropped image buffers to a custom Hugging Face Space running a FastAPI CLIP-ViT server to generate 512-dimension embeddings.
3. **Pinecone Vector Search**: It queries a Pinecone vector index using the embeddings to find the nearest matching card variant.
4. **Deck Code Generation**: The matched card IDs are resolved to game definition IDs and packaged into a standard base64 deck code.

## Ways to Use It

- **Server Commands**: Include `!deck` in a message with a screenshot, native forwarded message, or image URL.
- **Reactions**: Add a 🔍 reaction to any message containing an image.
- **Direct Messages**: Send a screenshot directly to the bot for a private response.

## Configuration

The bot requires the following variables (stored in a `.env` file for local development or as environment variables in your cloud dashboard):

| Variable | Description |
| :--- | :--- |
| `DISCORD_TOKEN` | Your Discord bot token from the [Developer Portal](https://discord.com/developers/applications). |
| `HF_TOKEN` | Your Hugging Face access token. |
| `EMBEDDING_API_URL` | The URL of your Hugging Face Space CLIP embedding server (e.g. `https://<space-name>.hf.space/embed`). |
| `PINECONE_API_KEY` | Your Pinecone database API key. |
| `PINECONE_INDEX_URL` | The URL of your Pinecone index. |
| `RENDER_EXTERNAL_URL` | (Optional) The public URL of your bot on Render to enable the keep-alive loop. |

## Local Setup & Index Synchronization

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file in the root directory and populate it with the configuration keys.
3. **Populate the Pinecone database**: Run the synchronization script to scan the MarvelSnap.pro CDN, generate CLIP embeddings for all card variants, and upsert them to Pinecone.
   ```bash
   node sync_variants.js
   ```
   *(Note: This creates local tracking files `known_variants.json` and `vectorized_variants.json` to allow incremental daily updates in under 2 seconds).*
4. Start the bot:
   ```bash
   npm start
   ```

## Deployment

The project is configured to run 24/7 on Render's free tier.

1. Create a new **Web Service** on Render and link this repository.
2. Set the runtime to **Node** (or **Docker** if using the provided Dockerfile).
3. Add the environment variables listed in the Configuration section.

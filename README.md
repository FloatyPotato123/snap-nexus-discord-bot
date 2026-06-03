# Snap Nexus Bot

A specialized Discord bot for the Marvel Snap community that converts deck screenshots into copy-pasteable short codes. Instead of manually typing out card names, users can get a deck code directly within Discord by having the bot "read" the image.

## How it works

The bot uses the Qwen3-VL vision model to analyze images. When an image is detected, the bot:
1. Extracts the names of the 12 cards shown in the screenshot.
2. Cross-references those names with a live database of Marvel Snap cards (via Untapped.gg) using fuzzy matching to account for any minor AI errors or misspellings.
3. Generates a short deck code compatible with the game's deck builder.

## Ways to use it

- **Server Commands**: Include `!deck` in a message with a screenshot or an image URL.
- **Reactions**: Add a 🔍 reaction to any message that has an image attached.
- **Direct Messages**: Send an image directly to the bot for a private response.
- **Forwards**: Use Discord's "Forward" button to send a message containing an image to the bot.

## Configuration

The bot requires the following environment variables (stored in a `.env` file for local development or as secrets in your cloud dashboard):

| Variable | Description |
| :--- | :--- |
| `DISCORD_TOKEN` | Your Discord bot token from the [Developer Portal](https://discord.com/developers/applications). |
| `HF_TOKEN` | Your [Hugging Face](https://huggingface.co/settings/tokens) access token (requires 'Write' permissions). |
| `RENDER_EXTERNAL_URL` | (Optional) The public URL of your bot to enable the 24/7 keep-alive loop. |

## Local Setup

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file in the root directory and add your tokens.
3. Start the bot:
   ```bash
   npm start
   ```

## Deployment

The project is configured to run 24/7 on Render's free tier. 

1. Create a new **Web Service** on Render and link this repository.
2. Set the runtime to **Docker**.
3. Add the environment variables listed in the Configuration section above.

## Limits and Performance

The bot is free to run, but relies on third-party API limits:
- **AI Inference**: The Hugging Face router typically allows roughly 10-20 deck identifications per hour.
- **Bandwidth**: Render provides 100GB of monthly bandwidth, covering roughly 200,000 deck images.

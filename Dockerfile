FROM node:18-slim

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy local code (excluding files in .gitignore)
COPY . .

# Run the bot
CMD ["npm", "start"]

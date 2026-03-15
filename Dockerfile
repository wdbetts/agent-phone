FROM node:22-slim AS base
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .

# Production server
FROM base AS server
EXPOSE 3000
CMD ["node", "server/index.js"]

# Mock Twilio + Mock Phone
FROM base AS mock
EXPOSE 3001 3002
CMD ["node", "mock/mock-twilio.js"]

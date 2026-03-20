FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source and build
COPY . .
RUN npm run build

EXPOSE 3001

CMD ["npm", "start"]

FROM node:20-alpine

WORKDIR /app

# Install ALL dependencies (including devDeps for TypeScript build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Remove devDependencies after build to slim down image
RUN npm prune --omit=dev

EXPOSE 3001

CMD ["npm", "start"]

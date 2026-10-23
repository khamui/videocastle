# syntax=docker/dockerfile:1

# --- Build stage: install all deps and build the SPA ---
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Runtime stage: single container serving API + SPA ---
FROM node:24-slim
# ffmpeg is the only external dependency (used by the transcoder; see spec).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY --from=build /app/web/dist ./web/dist

EXPOSE 8080
VOLUME ["/data"]
CMD ["npm", "run", "start"]

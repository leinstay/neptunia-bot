# neptunia-bot — production image.
# Only the dependencies live in the image; the project directory itself is
# bind-mounted by docker-compose.yml, so `git pull` + restart is a deploy and
# the private layer (.env, config.local.json, prompts.local/, data/) never
# ends up inside an image.

FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
CMD ["node", "src/index.js"]

FROM node:20-slim

# ffmpeg is not part of the base Node image; Render's runtime doesn't
# include it either, so it has to be installed at the OS layer here.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p uploads

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "server.js"]

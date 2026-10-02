FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --chown=node:node . .
RUN mkdir -p /app/uploads && chown node:node /app/uploads

USER node
EXPOSE 3000
CMD ["node", "server.js"]
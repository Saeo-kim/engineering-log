FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY src ./src
COPY public ./public
# Data lives on a volume mounted at /data (see README).
ENV DATABASE_FILE=/data/engineering-log.db
EXPOSE 3000
USER node
CMD ["npm", "start"]

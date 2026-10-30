FROM node:20-alpine

# Install build dependencies for native modules (better-sqlite3 against musl libc)
RUN apk add --no-cache python3 make g++ tini

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

RUN mkdir -p data

# Use tini to manage PID 1
ENTRYPOINT ["/sbin/tini", "--"]

EXPOSE 28080

CMD ["npm", "start"]

FROM node:20-alpine

RUN apk add --no-cache \
    mingw-w64-gcc \
    mingw-w64-binutils \
    7zip \
    curl \
    tar \
    gzip \
    make \
    g++ \
    python3

WORKDIR /app

COPY . .

RUN chmod +x scripts/build-windows.sh

CMD ["/bin/sh", "scripts/build-windows.sh"]


FROM node:24-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app

COPY server.js ./
COPY public ./public

ENV HOST=0.0.0.0
ENV PORT=3737
ENV PLEX_DB_PATH=/plex-db
ENV PLEX_CONTAINER_NAME=binhex-plexpass
ENV PLEX_SQLITE_IN_CONTAINER="/usr/lib/plexmediaserver/Plex SQLite"
ENV PLEX_CONFIG_PATH_HOST=/mnt/user/appdata/binhex-plexpass
ENV PLEX_DB_RELATIVE_PATH="Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db"
ENV BACKUP_DIR=/backups
ENV LOG_FILE=/logs/actions.log

EXPOSE 3737

CMD ["node", "server.js"]

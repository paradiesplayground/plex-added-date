# Plex Added Date

A small Unraid/Docker web app for changing Plex movie, TV show, and TV episode `added_at` dates in the Plex database.

The app is built for this setup:

- Plex container: `binhex-plexpass`
- Plex appdata root: `/mnt/user/appdata/binhex-plexpass`
- Plex database: `Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db`
- Backups: `/mnt/user/backups/plex-db-backups`
- Logs: `/mnt/user/appdata/plex-added-date/logs/actions.log`

It uses Plex's own `Plex SQLite` binary from the Plex Docker image, so it avoids the `unknown tokenizer: collating` problem that regular SQLite clients hit.

## Files To Copy

Copy this folder to Unraid:

```text
/mnt/user/appdata/plex-added-date
```

Required files:

```text
Dockerfile
docker-compose.yml
server.js
.dockerignore
.env.example
public/
```

## Install Or Rebuild

From the Unraid terminal:

```bash
cd "/mnt/user/appdata/plex-added-date"
cp .env.example .env
nano .env
docker compose up -d --build
```

Set a real username and password in `.env` before starting the container:

```text
AUTH_USERNAME=your-username
AUTH_PASSWORD=your-long-password
```

The container will refuse to start if `AUTH_PASSWORD` is left as `change-this-password`.

Open the app:

```text
http://tower:3737
```

Use your Unraid IP if `tower` does not resolve.

## Updating

After copying changed files to Unraid:

```bash
cd "/mnt/user/appdata/plex-added-date"
docker compose up -d --build
```

Then hard refresh the browser page with `Ctrl+F5`.

If authentication settings changed, update `.env` and rebuild:

```bash
docker compose up -d --build
```

## How It Works

The app container mounts:

```text
/mnt/user/appdata/binhex-plexpass/Plex Media Server/Plug-in Support/Databases:/plex-db
/mnt/user/backups/plex-db-backups:/backups
/mnt/user/appdata/plex-added-date/logs:/logs
/var/run/docker.sock:/var/run/docker.sock
```

The Docker socket is used to:

- inspect `binhex-plexpass` to find the Plex image
- run Plex SQLite in a temporary container from that image
- optionally stop Plex before applying changes
- restart Plex afterward if the app stopped it

The Plex SQLite command follows the same pattern as the original shell script:

```bash
docker run --rm -i \
  --entrypoint "/usr/lib/plexmediaserver/Plex SQLite" \
  -v "/mnt/user/appdata/binhex-plexpass:/config" \
  "<plex-image>" \
  "/config/Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db"
```

## Using The App

1. Open `http://tower:3737`.
2. Sign in with the username and password from `.env`.
3. Choose **Movies**, **TV shows**, or **TV episodes**.
4. Click **Load recent**.
5. Select the items to backdate.
6. Confirm the new added-at date. It defaults to today minus 6 months.
7. Leave **Create a database backup before applying** checked.
8. Leave **Stop Plex before applying and restart after** checked unless you already stopped Plex yourself.
9. Click **Apply updates**.

The manual ID box is at the bottom of the page as a fallback. You can paste IDs one per line, and each line can optionally override the date:

```text
12345
12346, 2024-12-25 09:30
12347 | 1703500200
```

## Backups And Logs

Backups are written before updates when the backup checkbox is enabled:

```text
/mnt/user/backups/plex-db-backups
```

Action logs are appended as JSON lines:

```text
/mnt/user/appdata/plex-added-date/logs/actions.log
```

Each log entry includes the timestamp, backup path, Plex stop/restart status, updated IDs, titles, old added date, and new added date.

## Authentication

The app uses HTTP Basic Auth. Credentials are required through environment variables:

```text
AUTH_USERNAME
AUTH_PASSWORD
```

The included `docker-compose.yml` reads them from `.env`. Do not commit `.env`; it is ignored by Git and Docker builds.

Basic Auth protects the app from casual LAN access, but it is not a reason to expose this service to the internet. Keep it on a trusted local network.

## Media Types

The selector maps to Plex `metadata_items.metadata_type` values:

```text
Movies      -> 1
TV shows    -> 2
TV episodes -> 4
```

**TV shows** means the show-level Plex metadata record. **TV episodes** means individual episode records. For episodes, the table includes extra detail from the parent show/season when Plex has it, such as `Show Name - S01E03`.

Preview and apply both enforce the selected type, so a movie ID will not be updated while **TV episodes** is selected, and vice versa.

## Customizing

Edit [docker-compose.yml](docker-compose.yml) if your paths differ.

Common values:

```yaml
PLEX_CONTAINER_NAME: binhex-plexpass
PLEX_CONFIG_PATH_HOST: /mnt/user/appdata/binhex-plexpass
PLEX_DB_RELATIVE_PATH: Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db
```

If your Plex appdata is on cache instead of user storage, change the paths from `/mnt/user/...` to `/mnt/cache/...`.

## Troubleshooting

Check the app logs:

```bash
docker logs plex-added-date
```

Check whether the container is running:

```bash
docker ps | grep plex-added-date
```

If the page loads but updates fail, confirm the Plex container name:

```bash
docker ps --format '{{.Names}}'
```

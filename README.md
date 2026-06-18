# ReelHook

A small, single-user personal file store for a local folder. Go backend, embedded
web UI, purple theme. Upload (multi-file + drag-drop), download, rename, delete,
create folders, and move files between folders.

## Layout

```
src/        Go source + embedded web UI (go.mod lives here)
config/     config.json (auth)
storage/    default local folder served to the user
Dockerfile, docker-compose.yml
```

## Quick start

```bash
# 1. Create your config from the template and set username/password
cp config/config.example.json config/config.json
$EDITOR config/config.json

# 2. Create your compose file from the template and set the host storage path
cp docker-compose.example.yml docker-compose.yml
$EDITOR docker-compose.yml

# 3. Point storage at whatever folder you want to serve (or leave as-is)
mkdir -p storage

# 4. Run it
docker compose up --build -d
```

`config/config.json` and `docker-compose.yml` are git-ignored so your real
credentials and local host paths never get committed;
`config/config.example.json` and `docker-compose.example.yml` are the tracked
templates.

Open <http://127.0.0.1:8080> and sign in.

## Config

`config/config.json` — plaintext credentials for now:

```json
{
  "users": [
    { "username": "admin", "password": "changeme" }
  ]
}
```

Multiple users are supported (add more objects), but this is built for personal
single-user use.

## Environment variables

| Var           | Default                | Meaning                          |
|---------------|------------------------|----------------------------------|
| `LISTEN_ADDR` | `:8080`                  | Address/port to listen on      |
| `STORAGE_DIR` | `../storage`             | Root folder served to the user |
| `CONFIG_PATH` | `../config/config.json`  | Path to the JSON auth config   |

(Defaults assume local dev run from `./src`; Docker sets `/data` and
`/config/config.json` explicitly.)

In `docker-compose.yml` the storage folder is mounted from `./storage` and the
config directory from `./config`. Change the storage host path to serve a
different local folder.

## Run without Docker

```bash
cd src
go run .          # uses ../config/config.json and ../storage by default
# or
go build -o reelhook . && ./reelhook
```

package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

//go:embed web
var webFS embed.FS

// App holds shared server state.
type App struct {
	StorageDir string
	Sessions   *SessionStore
	Config     *Config
}

func main() {
	// Defaults assume you run from ./src during local dev; Docker overrides
	// both via environment variables in docker-compose.yml.
	cfgPath := envOr("CONFIG_PATH", "../config/config.json")
	storageDir := envOr("STORAGE_DIR", "../storage")
	addr := envOr("LISTEN_ADDR", ":8080")

	cfg, err := LoadConfig(cfgPath)
	if err != nil {
		log.Fatalf("load config %q: %v", cfgPath, err)
	}

	abs, err := filepath.Abs(storageDir)
	if err != nil {
		log.Fatalf("resolve storage dir: %v", err)
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		log.Fatalf("create storage dir %q: %v", abs, err)
	}

	app := &App{
		StorageDir: abs,
		Sessions:   NewSessionStore(),
		Config:     cfg,
	}

	staticFS, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("sub fs: %v", err)
	}

	mux := http.NewServeMux()

	// Static assets (css/js) served from the embedded fs.
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))))

	// Auth pages.
	mux.HandleFunc("GET /login", app.handleLoginPage(staticFS))
	mux.HandleFunc("POST /login", app.handleLogin)
	mux.HandleFunc("POST /logout", app.handleLogout)

	// App shell (protected).
	mux.HandleFunc("GET /{$}", app.requireAuth(app.handleAppShell(staticFS)))

	// JSON / file API (protected).
	mux.HandleFunc("GET /api/list", app.requireAuth(app.handleList))
	mux.HandleFunc("GET /api/download", app.requireAuth(app.handleDownload))
	mux.HandleFunc("POST /api/zip", app.requireAuth(app.handleZip))
	mux.HandleFunc("POST /api/upload", app.requireAuth(app.handleUpload))
	mux.HandleFunc("POST /api/delete", app.requireAuth(app.handleDelete))
	mux.HandleFunc("POST /api/rename", app.requireAuth(app.handleRename))
	mux.HandleFunc("POST /api/mkdir", app.requireAuth(app.handleMkdir))
	mux.HandleFunc("POST /api/move", app.requireAuth(app.handleMove))

	log.Printf("ReelHook listening on %s  (storage: %s)", addr, abs)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

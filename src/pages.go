package main

import (
	"bytes"
	"io/fs"
	"net/http"
)

// themePlaceholder is replaced in the served HTML with the configured default
// scheme so the page renders in the right colours before any script runs.
const themePlaceholder = "__THEME__"

// handleAppShell serves the main single-page app.
func (a *App) handleAppShell(staticFS fs.FS) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a.serveFile(w, staticFS, "index.html")
	}
}

// handleLoginPage serves the login form. If already authenticated, bounce home.
func (a *App) handleLoginPage(staticFS fs.FS) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if c, err := r.Cookie(sessionCookie); err == nil {
			if _, ok := a.Sessions.lookup(c.Value); ok {
				http.Redirect(w, r, "/", http.StatusSeeOther)
				return
			}
		}
		a.serveFile(w, staticFS, "login.html")
	}
}

func (a *App) serveFile(w http.ResponseWriter, staticFS fs.FS, name string) {
	b, err := fs.ReadFile(staticFS, name)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	b = bytes.ReplaceAll(b, []byte(themePlaceholder), []byte(a.Config.theme()))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(b)
}

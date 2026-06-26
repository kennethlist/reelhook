package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"sync"
	"time"
)

// Config is the on-disk JSON config.
type Config struct {
	Users []User `json:"users"`
	// Theme is the default colour scheme ("light" or "dark") applied before a
	// visitor has picked one. A per-browser choice (localStorage) overrides it.
	Theme string `json:"theme"`
	// Share is an optional secret token. A request carrying ?share=<token> in
	// its query string bypasses the login form entirely. Leave empty to disable.
	// NOTE: this is a bearer secret in a URL — it leaks into server/proxy logs
	// and browser history, and grants full read/write/delete access, so treat
	// any link containing it as a password.
	Share string `json:"share"`
}

// shareOK reports whether token matches the configured share secret. An empty
// configured secret disables the bypass (any token is rejected). The compare is
// constant-time to avoid trivial guessing via timing.
func (c *Config) shareOK(token string) bool {
	if c.Share == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(c.Share), []byte(token)) == 1
}

// theme returns the configured default scheme, falling back to "light" for any
// missing or unrecognised value.
func (c *Config) theme() string {
	if c.Theme == "dark" {
		return "dark"
	}
	return "light"
}

type User struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func LoadConfig(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// authenticate returns true if the username/password pair matches a configured
// user. Comparison is constant-time to avoid trivial timing leaks.
func (c *Config) authenticate(username, password string) bool {
	for _, u := range c.Users {
		userOK := subtle.ConstantTimeCompare([]byte(u.Username), []byte(username)) == 1
		passOK := subtle.ConstantTimeCompare([]byte(u.Password), []byte(password)) == 1
		if userOK && passOK {
			return true
		}
	}
	return false
}

const sessionCookie = "reelhook_session"
const sessionTTL = 7 * 24 * time.Hour

type session struct {
	username string
	expires  time.Time
}

// SessionStore is an in-memory token -> session map. Single-user/personal use,
// so memory is fine; restarting the server logs everyone out.
type SessionStore struct {
	mu       sync.Mutex
	sessions map[string]session
}

func NewSessionStore() *SessionStore {
	return &SessionStore{sessions: make(map[string]session)}
}

func (s *SessionStore) create(username string) string {
	tok := randomToken()
	s.mu.Lock()
	s.sessions[tok] = session{username: username, expires: time.Now().Add(sessionTTL)}
	s.mu.Unlock()
	return tok
}

func (s *SessionStore) lookup(tok string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[tok]
	if !ok {
		return "", false
	}
	if time.Now().After(sess.expires) {
		delete(s.sessions, tok)
		return "", false
	}
	return sess.username, true
}

func (s *SessionStore) destroy(tok string) {
	s.mu.Lock()
	delete(s.sessions, tok)
	s.mu.Unlock()
}

func randomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand failure is unrecoverable
	}
	return hex.EncodeToString(b)
}

// requireAuth wraps a handler, redirecting/erroring unauthenticated requests.
func (a *App) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookie)
		if err == nil {
			if _, ok := a.Sessions.lookup(c.Value); ok {
				next(w, r)
				return
			}
		}
		// A valid ?share=<token> bypasses the login form. Mint a session and
		// set the cookie so subsequent page and /api/ requests are authenticated
		// without having to carry the token on every URL.
		if a.Config.shareOK(r.URL.Query().Get("share")) {
			tok := a.Sessions.create("share")
			http.SetCookie(w, &http.Cookie{
				Name:     sessionCookie,
				Value:    tok,
				Path:     "/",
				HttpOnly: true,
				SameSite: http.SameSiteLaxMode,
				MaxAge:   int(sessionTTL.Seconds()),
			})
			next(w, r)
			return
		}
		// API calls get a 401; page loads get redirected to login.
		if isAPIPath(r.URL.Path) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		http.Redirect(w, r, "/login", http.StatusSeeOther)
	}
}

func isAPIPath(p string) bool {
	return len(p) >= 5 && p[:5] == "/api/"
}

func (a *App) handleLogin(w http.ResponseWriter, r *http.Request) {
	username := r.FormValue("username")
	password := r.FormValue("password")
	if !a.Config.authenticate(username, password) {
		http.Redirect(w, r, "/login?error=1", http.StatusSeeOther)
		return
	}
	tok := a.Sessions.create(username)
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    tok,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionTTL.Seconds()),
	})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (a *App) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		a.Sessions.destroy(c.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
	})
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

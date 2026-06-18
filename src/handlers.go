package main

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Pagination bounds for directory listings. A directory can hold tens of
// thousands of entries; we never serialise (or stat) more than one page worth
// at a time so both the wire payload and the rendered DOM stay bounded.
const (
	defaultListLimit = 200
	maxListLimit     = 1000
)

// safePath resolves a user-supplied relative path against the storage root,
// rejecting anything that would escape it (path traversal, absolute paths).
func (a *App) safePath(rel string) (string, error) {
	// Normalise: treat as rooted, clean, then strip the leading slash.
	clean := path.Clean("/" + strings.TrimSpace(rel))
	clean = strings.TrimPrefix(clean, "/")
	full := filepath.Join(a.StorageDir, filepath.FromSlash(clean))

	// Defence in depth: ensure the result is still within the root.
	if !within(a.StorageDir, full) {
		return "", errors.New("invalid path")
	}
	return full, nil
}

func within(root, p string) bool {
	rootClean := filepath.Clean(root)
	pClean := filepath.Clean(p)
	if pClean == rootClean {
		return true
	}
	return strings.HasPrefix(pClean, rootClean+string(os.PathSeparator))
}

type entry struct {
	Name    string `json:"name"`
	IsDir   bool   `json:"is_dir"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"mod_time"`
}

type listResponse struct {
	Path    string  `json:"path"`
	Entries []entry `json:"entries"`
	Total   int     `json:"total"`  // total entries in the directory (before paging)
	Offset  int     `json:"offset"` // index of the first returned entry
	Limit   int     `json:"limit"`  // page size actually applied
}

func (e entry) kind() string {
	if e.IsDir {
		return "Folder"
	}
	if i := strings.LastIndex(e.Name, "."); i > 0 {
		return strings.ToUpper(e.Name[i+1:])
	}
	return "File"
}

// naturalCompare orders names case-insensitively, comparing runs of digits by
// numeric value so "file2" sorts before "file10". Mirrors the frontend's
// localeCompare({numeric:true}) so server- and client-side order agree.
func naturalCompare(a, b string) int {
	a, b = strings.ToLower(a), strings.ToLower(b)
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		ca, cb := a[i], b[j]
		da, db := ca >= '0' && ca <= '9', cb >= '0' && cb <= '9'
		if da && db {
			si, sj := i, j
			for i < len(a) && a[i] >= '0' && a[i] <= '9' {
				i++
			}
			for j < len(b) && b[j] >= '0' && b[j] <= '9' {
				j++
			}
			na := strings.TrimLeft(a[si:i], "0")
			nb := strings.TrimLeft(b[sj:j], "0")
			if len(na) != len(nb) {
				return len(na) - len(nb)
			}
			if na != nb {
				if na < nb {
					return -1
				}
				return 1
			}
			continue // numerically equal, keep scanning
		}
		if ca != cb {
			if ca < cb {
				return -1
			}
			return 1
		}
		i++
		j++
	}
	return (len(a) - i) - (len(b) - j)
}

func parseIntDefault(s string, def int) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return def
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func (a *App) handleList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	rel := q.Get("path")
	dir, err := a.safePath(rel)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	des, err := os.ReadDir(dir)
	if err != nil {
		writeErr(w, http.StatusNotFound, "cannot read directory")
		return
	}

	sortKey := q.Get("sort")
	switch sortKey {
	case "size", "mod", "kind":
		// valid
	default:
		sortKey = "name"
	}
	desc := q.Get("dir") == "desc"

	// Optional case-insensitive substring filter on the entry name. Applied
	// before sorting/paging so `total` reflects the matching set and the pager
	// walks the filtered results, not the whole directory.
	filter := strings.ToLower(strings.TrimSpace(q.Get("q")))

	offset := parseIntDefault(q.Get("offset"), 0)
	if offset < 0 {
		offset = 0
	}
	limit := parseIntDefault(q.Get("limit"), defaultListLimit)
	if limit <= 0 || limit > maxListLimit {
		limit = defaultListLimit
	}

	// Sorting by size/mod needs every entry's FileInfo, so stat the whole
	// directory up front. Name/kind sorts only need the dir entry name, so we
	// defer stat()ing to just the page that ends up being served — for a
	// directory with tens of thousands of files that turns ~N stat calls into
	// ~limit of them.
	statAll := sortKey == "size" || sortKey == "mod"
	entries := make([]entry, 0, len(des))
	for _, de := range des {
		name := de.Name()
		if filter != "" && !strings.Contains(strings.ToLower(name), filter) {
			continue
		}
		e := entry{Name: name, IsDir: de.IsDir()}
		if statAll {
			if info, err := de.Info(); err != nil {
				continue
			} else {
				e.Size = info.Size()
				e.ModTime = info.ModTime().Unix()
			}
		}
		entries = append(entries, e)
	}

	// Folders are always grouped first regardless of sort direction; within a
	// group the chosen key applies, with the name as a stable tiebreak.
	sort.SliceStable(entries, func(i, j int) bool {
		a, b := entries[i], entries[j]
		if a.IsDir != b.IsDir {
			return a.IsDir
		}
		c := 0
		switch sortKey {
		case "size":
			c = int(sign(a.Size - b.Size))
		case "mod":
			c = int(sign(a.ModTime - b.ModTime))
		case "kind":
			c = strings.Compare(a.kind(), b.kind())
		}
		if c == 0 {
			c = naturalCompare(a.Name, b.Name)
		}
		if desc {
			c = -c
		}
		return c < 0
	})

	total := len(entries)
	if offset > total {
		offset = total
	}
	end := offset + limit
	if end > total {
		end = total
	}
	page := entries[offset:end]

	// Fill in size/mod for the served page when we skipped the full stat pass.
	if !statAll {
		for i := range page {
			if info, err := os.Stat(filepath.Join(dir, page[i].Name)); err == nil {
				page[i].Size = info.Size()
				page[i].ModTime = info.ModTime().Unix()
			}
		}
	}

	cleanRel := strings.TrimPrefix(path.Clean("/"+rel), "/")
	writeJSON(w, listResponse{
		Path:    cleanRel,
		Entries: page,
		Total:   total,
		Offset:  offset,
		Limit:   limit,
	})
}

func sign(n int64) int64 {
	switch {
	case n < 0:
		return -1
	case n > 0:
		return 1
	default:
		return 0
	}
}

func (a *App) handleDownload(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("path")
	full, err := a.safePath(rel)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	name := filepath.Base(full)
	w.Header().Set("Content-Disposition", "attachment; filename=\""+strings.ReplaceAll(name, "\"", "")+"\"")
	http.ServeFile(w, r, full)
}

func (a *App) handleUpload(w http.ResponseWriter, r *http.Request) {
	dest := r.URL.Query().Get("path")
	destDir, err := a.safePath(dest)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if info, err := os.Stat(destDir); err != nil || !info.IsDir() {
		writeErr(w, http.StatusBadRequest, "destination is not a directory")
		return
	}
	// Stream parts so large uploads don't buffer fully in memory.
	reader, err := r.MultipartReader()
	if err != nil {
		writeErr(w, http.StatusBadRequest, "expected multipart form")
		return
	}
	var saved []string
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad multipart data")
			return
		}
		if part.FormName() != "files" || part.FileName() == "" {
			continue
		}
		name := filepath.Base(part.FileName())
		if name == "." || name == ".." || name == "" {
			continue
		}
		target := filepath.Join(destDir, name)
		if !within(a.StorageDir, target) {
			continue
		}
		out, err := os.Create(target)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "cannot write file")
			return
		}
		if _, err := io.Copy(out, part); err != nil {
			out.Close()
			writeErr(w, http.StatusInternalServerError, "write failed")
			return
		}
		out.Close()
		saved = append(saved, name)
	}
	writeJSON(w, map[string]any{"saved": saved})
}

type pathReq struct {
	Path string `json:"path"`
}

func (a *App) handleDelete(w http.ResponseWriter, r *http.Request) {
	var req pathReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	full, err := a.safePath(req.Path)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if filepath.Clean(full) == filepath.Clean(a.StorageDir) {
		writeErr(w, http.StatusBadRequest, "cannot delete root")
		return
	}
	if err := os.RemoveAll(full); err != nil {
		writeErr(w, http.StatusInternalServerError, "delete failed")
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

type renameReq struct {
	Path    string `json:"path"`
	NewName string `json:"new_name"`
}

func (a *App) handleRename(w http.ResponseWriter, r *http.Request) {
	var req renameReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	full, err := a.safePath(req.Path)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	newName := filepath.Base(strings.TrimSpace(req.NewName))
	if newName == "" || newName == "." || newName == ".." || strings.ContainsAny(newName, "/\\") {
		writeErr(w, http.StatusBadRequest, "invalid name")
		return
	}
	target := filepath.Join(filepath.Dir(full), newName)
	if !within(a.StorageDir, target) {
		writeErr(w, http.StatusBadRequest, "invalid target")
		return
	}
	if _, err := os.Stat(target); err == nil {
		writeErr(w, http.StatusConflict, "name already exists")
		return
	}
	if err := os.Rename(full, target); err != nil {
		writeErr(w, http.StatusInternalServerError, "rename failed")
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

type mkdirReq struct {
	Path string `json:"path"` // parent dir
	Name string `json:"name"`
}

func (a *App) handleMkdir(w http.ResponseWriter, r *http.Request) {
	var req mkdirReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	parent, err := a.safePath(req.Path)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	name := filepath.Base(strings.TrimSpace(req.Name))
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\") {
		writeErr(w, http.StatusBadRequest, "invalid folder name")
		return
	}
	target := filepath.Join(parent, name)
	if !within(a.StorageDir, target) {
		writeErr(w, http.StatusBadRequest, "invalid target")
		return
	}
	if err := os.Mkdir(target, 0o755); err != nil {
		if errors.Is(err, fs.ErrExist) {
			writeErr(w, http.StatusConflict, "folder already exists")
			return
		}
		writeErr(w, http.StatusInternalServerError, "mkdir failed")
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// handleZip streams a zip archive of one or more paths (files and/or folders).
// Paths come as repeated `path` form values so a bulk selection of any size
// works (a POSTed form has no practical length limit, unlike a URL).
func (a *App) handleZip(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		writeErr(w, http.StatusBadRequest, "bad form")
		return
	}
	rels := r.Form["path"]
	if len(rels) == 0 {
		writeErr(w, http.StatusBadRequest, "no paths given")
		return
	}

	// Resolve and validate everything BEFORE writing any output — once the
	// archive stream starts we can no longer change the status code.
	type src struct {
		full, base string
		isDir      bool
	}
	srcs := make([]src, 0, len(rels))
	for _, rel := range rels {
		full, err := a.safePath(rel)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		info, err := os.Stat(full)
		if err != nil {
			writeErr(w, http.StatusNotFound, "not found: "+rel)
			return
		}
		srcs = append(srcs, src{full: full, base: filepath.Base(full), isDir: info.IsDir()})
	}

	dlName := "reelhook-export.zip"
	if len(srcs) == 1 {
		dlName = srcs[0].base + ".zip"
	}
	dlName = strings.NewReplacer("\"", "", "\n", "", "\r", "", "/", "_").Replace(dlName)

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+dlName+"\"")

	zw := zip.NewWriter(w)
	defer zw.Close()
	for _, s := range srcs {
		if s.isDir {
			_ = addDirToZip(zw, s.full, s.base)
		} else {
			_ = addFileToZip(zw, s.full, s.base)
		}
	}
}

func addDirToZip(zw *zip.Writer, root, base string) error {
	return filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip unreadable entries rather than aborting the whole archive
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return nil
		}
		name := path.Join(base, filepath.ToSlash(rel))
		if info.IsDir() {
			if rel == "." {
				return nil
			}
			_, err := zw.Create(name + "/")
			return err
		}
		return addFileToZip(zw, p, name)
	})
}

func addFileToZip(zw *zip.Writer, p, name string) error {
	f, err := os.Open(p)
	if err != nil {
		return nil
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil
	}
	hdr, err := zip.FileInfoHeader(info)
	if err != nil {
		return err
	}
	hdr.Name = filepath.ToSlash(name)
	hdr.Method = zip.Deflate
	ze, err := zw.CreateHeader(hdr)
	if err != nil {
		return err
	}
	_, err = io.Copy(ze, f)
	return err
}

type moveReq struct {
	Src string `json:"src"` // file/folder to move
	Dst string `json:"dst"` // destination directory
}

func (a *App) handleMove(w http.ResponseWriter, r *http.Request) {
	var req moveReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	src, err := a.safePath(req.Src)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	dstDir, err := a.safePath(req.Dst)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if info, err := os.Stat(dstDir); err != nil || !info.IsDir() {
		writeErr(w, http.StatusBadRequest, "destination is not a directory")
		return
	}
	target := filepath.Join(dstDir, filepath.Base(src))
	if !within(a.StorageDir, target) {
		writeErr(w, http.StatusBadRequest, "invalid target")
		return
	}
	// Disallow moving a folder into itself or its own subtree.
	if within(src, dstDir) {
		writeErr(w, http.StatusBadRequest, "cannot move into itself")
		return
	}
	if _, err := os.Stat(target); err == nil {
		writeErr(w, http.StatusConflict, "name already exists at destination")
		return
	}
	if err := os.Rename(src, target); err != nil {
		writeErr(w, http.StatusInternalServerError, "move failed")
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

package main

// REST API: регистрация, логин, logout, me, users, history + CORS на всё /api/* и /ws.

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"
)

// apiServer — REST-часть сервера.
type apiServer struct {
	store *Store
	hub   *Hub
}

// registerRoutes — регистрация всех HTTP-маршрутов.
func (a *apiServer) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/ws", a.hub.handleWS)
	mux.HandleFunc("/api/register", a.handleRegister)
	mux.HandleFunc("/api/login", a.handleLogin)
	mux.HandleFunc("/api/logout", a.handleLogout)
	mux.HandleFunc("/api/me", a.handleMe)
	mux.HandleFunc("/api/users", a.handleUsers)
	mux.HandleFunc("/api/history/", a.handleHistory)
}

// setCors — CORS-заголовки на все ответы (клиент работает из Tauri и браузера).
func setCors(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
}

// corsPreflight — единый обработчик OPTIONS; true, если запрос обработан.
func corsPreflight(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == http.MethodOptions {
		setCors(w)
		w.WriteHeader(http.StatusNoContent)
		return true
	}
	return false
}

// writeJSON — ответ JSON-телом с CORS-заголовками.
func writeJSON(w http.ResponseWriter, status int, v any) {
	setCors(w)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeErr — стандартная ошибка протокола {"error":"..."}.
func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// authUID — Bearer-токен из заголовка → uid (0, если не авторизован).
func authUID(r *http.Request, s *Store) int64 {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return 0
	}
	return s.TokenUID(strings.TrimPrefix(h, prefix))
}

// handleRegister — POST /api/register {name,password,avatar}.
func (a *apiServer) handleRegister(w http.ResponseWriter, r *http.Request) {
	if corsPreflight(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "метод не поддерживается")
		return
	}
	var in struct {
		Name     string `json:"name"`
		Password string `json:"password"`
		Avatar   *int   `json:"avatar"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "битый JSON")
		return
	}
	name := strings.TrimSpace(in.Name)
	n := utf8.RuneCountInString(name)
	if n < 2 || n > 24 {
		writeErr(w, http.StatusBadRequest, "имя: 2–24 символа")
		return
	}
	if pn := utf8.RuneCountInString(in.Password); pn < 4 || pn > 64 {
		writeErr(w, http.StatusBadRequest, "пароль: 4–64 символа")
		return
	}
	avatar := 0
	if in.Avatar != nil {
		avatar = *in.Avatar
	}
	if avatar < 0 || avatar > 5 {
		writeErr(w, http.StatusBadRequest, "avatar: 0..5")
		return
	}
	u, token, err := a.store.CreateUser(name, in.Password, avatar, false)
	if err == ErrNameTaken {
		writeErr(w, http.StatusConflict, "имя занято")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка регистрации")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token": token,
		"user":  map[string]any{"id": u.ID, "name": u.Name, "avatar": u.Avatar},
	})
}

// handleLogin — POST /api/login {name,password}.
func (a *apiServer) handleLogin(w http.ResponseWriter, r *http.Request) {
	if corsPreflight(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "метод не поддерживается")
		return
	}
	var in struct {
		Name     string `json:"name"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "битый JSON")
		return
	}
	u, token, err := a.store.Login(in.Name, in.Password)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "неверные данные")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token": token,
		"user":  map[string]any{"id": u.ID, "name": u.Name, "avatar": u.Avatar},
	})
}

// handleLogout — POST /api/logout, 204 без тела.
func (a *apiServer) handleLogout(w http.ResponseWriter, r *http.Request) {
	if corsPreflight(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "метод не поддерживается")
		return
	}
	a.store.DeleteToken(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	setCors(w)
	w.WriteHeader(http.StatusNoContent)
}

// handleMe — GET /api/me → свой профиль со статусом и настроением.
func (a *apiServer) handleMe(w http.ResponseWriter, r *http.Request) {
	if corsPreflight(w, r) {
		return
	}
	uid := authUID(r, a.store)
	if uid == 0 {
		writeErr(w, http.StatusUnauthorized, "не авторизован")
		return
	}
	u := a.store.SnapshotUser(uid)
	if u == nil {
		writeErr(w, http.StatusUnauthorized, "не авторизован")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]any{
			"id": u.ID, "name": u.Name, "avatar": u.Avatar,
			"status": u.Status, "mood": u.Mood,
		},
	})
}

// handleUsers — GET /api/users → все, кроме себя.
func (a *apiServer) handleUsers(w http.ResponseWriter, r *http.Request) {
	if corsPreflight(w, r) {
		return
	}
	uid := authUID(r, a.store)
	if uid == 0 {
		writeErr(w, http.StatusUnauthorized, "не авторизован")
		return
	}
	users := []map[string]any{}
	for _, u := range a.store.UsersAll() {
		if u.ID == uid {
			continue
		}
		status, lastSeen := a.hub.publicStatus(u)
		users = append(users, map[string]any{
			"id": u.ID, "name": u.Name, "avatar": u.Avatar,
			"status": status, "mood": u.Mood, "lastSeen": lastSeen, "bot": u.Bot,
		})
	}
	writeJSON(w, http.StatusOK, users)
}

// handleHistory — GET /api/history/{uid}?before=N&limit=100.
func (a *apiServer) handleHistory(w http.ResponseWriter, r *http.Request) {
	if corsPreflight(w, r) {
		return
	}
	uid := authUID(r, a.store)
	if uid == 0 {
		writeErr(w, http.StatusUnauthorized, "не авторизован")
		return
	}
	peerID, err := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, "/api/history/"), 10, 64)
	if err != nil || peerID == uid || a.store.UserByID(peerID) == nil {
		writeErr(w, http.StatusNotFound, "собеседник не найден")
		return
	}
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	limit, convErr := strconv.Atoi(r.URL.Query().Get("limit"))
	if convErr != nil || limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	msgs, hasMore := a.store.History(uid, peerID, before, limit)
	if msgs == nil {
		msgs = []Msg{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs, "hasMore": hasMore})
}

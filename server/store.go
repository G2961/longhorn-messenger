package main

// JSON-хранилище: пользователи, токены, переписки map[пара][]Msg со сквозным seq на пару.
// Запись атомарная (tmp+rename), автосохранение дебаунсом ~500мс и при завершении.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// User — запись пользователя.
type User struct {
	ID       int64           `json:"id"`
	Name     string          `json:"name"`
	Avatar   int             `json:"avatar"`
	Bot      bool            `json:"bot,omitempty"`
	Salt     string          `json:"salt"`
	Password string          `json:"password"` // hex(sha256(salt+пароль))
	Status   string          `json:"status"`   // сохранённый ручной статус on/idle/dnd/inv
	Mood     string          `json:"mood"`
	LastSeen int64           `json:"lastSeen"`
	ReadSeq  map[int64]int64 `json:"readSeq,omitempty"` // собеседник → мой последний прочитанный seq
}

// Msg — сообщение в переписке пары юзеров.
type Msg struct {
	Seq  int64  `json:"seq"`
	From int64  `json:"from"`
	ID   string `json:"id"` // серверный идентификатор (s17); для sys может быть ""
	Text string `json:"text"`
	Time int64  `json:"time"`
	Sys  bool   `json:"sys"`
	// Метаданные sys-записей о звонках (иначе после перезагрузки истории
	// фронт не может собрать фразу «Звонок с <имя>, 01:23»).
	SysOp string `json:"sysop,omitempty"` // end/missed/cancel/reject/busy
	Peer  int64  `json:"peer,omitempty"`  // второй участник
	DurMS int64  `json:"dur,omitempty"`   // длительность разговора (end)
}

// dbFile — формат файла db.json.
type dbFile struct {
	NextUserID int64            `json:"nextUserId"`
	Users      map[int64]*User  `json:"users"`
	Tokens     map[string]int64 `json:"tokens"` // токен → uid
	Convs      map[string][]Msg `json:"convs"`  // ключ "min:max"
	NextSeq    map[string]int64 `json:"nextSeq"`
}

// Store — потокобезопасное хранилище с дебаунсом сохранения.
type Store struct {
	mu   sync.RWMutex
	path string
	db   *dbFile

	saveMu    sync.Mutex
	saveTimer *time.Timer
	dirty     bool
	closed    bool
}

// Ошибки хранилища.
var (
	ErrNameTaken = errors.New("имя занято")
	ErrBadCreds  = errors.New("неверные данные")
)

// newStore открывает (или создаёт пустую) базу по пути.
func newStore(path string) (*Store, error) {
	s := &Store{path: path}
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		var db dbFile
		if err := json.Unmarshal(data, &db); err != nil {
			return nil, errors.New("битый db.json: " + err.Error())
		}
		s.db = &db
	case os.IsNotExist(err):
		// Файла нет — создаём свежую пустую базу.
		s.db = &dbFile{
			NextUserID: 1,
			Users:      map[int64]*User{},
			Tokens:     map[string]int64{},
			Convs:      map[string][]Msg{},
			NextSeq:    map[string]int64{},
		}
	default:
		return nil, err
	}
	if s.db.Users == nil {
		s.db.Users = map[int64]*User{}
	}
	if s.db.Tokens == nil {
		s.db.Tokens = map[string]int64{}
	}
	if s.db.Convs == nil {
		s.db.Convs = map[string][]Msg{}
	}
	if s.db.NextSeq == nil {
		s.db.NextSeq = map[string]int64{}
	}
	if s.db.NextUserID == 0 {
		s.db.NextUserID = 1
	}
	return s, nil
}

// --- сохранение ---

// scheduleSave — дебаунс: пометить изменения и записать файл через 500мс после последнего.
func (s *Store) scheduleSave() {
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	if s.closed {
		return
	}
	s.dirty = true
	if s.saveTimer == nil {
		s.saveTimer = time.AfterFunc(500*time.Millisecond, s.timerFlush)
	} else {
		s.saveTimer.Reset(500 * time.Millisecond)
	}
}

// timerFlush — колбэк таймера дебаунса.
func (s *Store) timerFlush() {
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	s.writeIfDirty()
}

// writeIfDirty — записать файл при наличии изменений (вызывать под saveMu).
func (s *Store) writeIfDirty() {
	if !s.dirty || s.closed {
		return
	}
	s.mu.RLock()
	data, err := json.Marshal(s.db)
	s.mu.RUnlock()
	if err != nil {
		log.Printf("store: ошибка сериализации: %v", err)
		return
	}
	if err := atomicWrite(s.path, data); err != nil {
		log.Printf("store: ошибка записи %s: %v", s.path, err)
		return
	}
	s.dirty = false
}

// flush — принудительно сохранить немедленно.
func (s *Store) flush() {
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	if s.saveTimer != nil {
		s.saveTimer.Stop()
		s.saveTimer = nil
	}
	s.writeIfDirty()
}

// close — финальное сохранение и запрет дальнейших записей.
func (s *Store) close() {
	s.flush()
	s.saveMu.Lock()
	s.closed = true
	s.saveMu.Unlock()
}

// atomicWrite — запись во временный файл и rename поверх целевого.
func atomicWrite(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".db-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}

// hashPassword — hex(sha256(salt + пароль)).
func hashPassword(salt, password string) string {
	sum := sha256.Sum256([]byte(salt + password))
	return hex.EncodeToString(sum[:])
}

// newToken — случайный 32-байтный токен в hex.
func newToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// convKey — ключ переписки для пары uid (независимо от порядка).
func convKey(a, b int64) string {
	if a > b {
		a, b = b, a
	}
	return strconv.FormatInt(a, 10) + ":" + strconv.FormatInt(b, 10)
}

// --- пользователи ---

// CreateUser регистрирует пользователя и сразу выдаёт токен.
func (s *Store) CreateUser(name, password string, avatar int, bot bool) (*User, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, u := range s.db.Users {
		if strings.EqualFold(u.Name, name) {
			return nil, "", ErrNameTaken
		}
	}
	salt := newToken()[:16]
	u := &User{
		ID:      s.db.NextUserID,
		Name:    name,
		Avatar:  avatar,
		Bot:     bot,
		Salt:    salt,
		Status:  "on",
		ReadSeq: map[int64]int64{},
	}
	u.Password = hashPassword(salt, password)
	s.db.NextUserID++
	s.db.Users[u.ID] = u
	token := newToken()
	s.db.Tokens[token] = u.ID
	s.scheduleSave()
	return u, token, nil
}

// Login проверяет учётные данные и выпускает токен.
func (s *Store) Login(name, password string) (*User, string, error) {
	s.mu.RLock()
	var found *User
	for _, u := range s.db.Users {
		if strings.EqualFold(u.Name, name) {
			found = u
			break
		}
	}
	if found == nil || found.Password != hashPassword(found.Salt, password) {
		s.mu.RUnlock()
		return nil, "", ErrBadCreds
	}
	s.mu.RUnlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	token := newToken()
	s.db.Tokens[token] = found.ID
	s.scheduleSave()
	return found, token, nil
}

// UserByID — пользователь по id (nil, если нет).
func (s *Store) UserByID(id int64) *User {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.db.Users[id]
}

// UserByName — первый пользователь с этим именем без учёта регистра (nil, если нет).
func (s *Store) UserByName(name string) *User {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, u := range s.db.Users {
		if strings.EqualFold(u.Name, name) {
			return u
		}
	}
	return nil
}

// UsersAll — все пользователи, отсортированные по id (указатели валидны под локом хранилища).
func (s *Store) UsersAll() []*User {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*User, 0, len(s.db.Users))
	for _, u := range s.db.Users {
		out = append(out, u)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// SnapshotUsersAll — копии всех пользователей (для безопасного чтения вне локов).
func (s *Store) SnapshotUsersAll() []*User {
	list := s.UsersAll()
	out := make([]*User, len(list))
	for i, u := range list {
		cp := *u
		if u.ReadSeq != nil {
			cp.ReadSeq = make(map[int64]int64, len(u.ReadSeq))
			for k, v := range u.ReadSeq {
				cp.ReadSeq[k] = v
			}
		}
		out[i] = &cp
	}
	return out
}

// TokenUID — uid по токену (0, если токен неизвестен).
func (s *Store) TokenUID(token string) int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.db.Tokens[token]
}

// DeleteToken — logout.
func (s *Store) DeleteToken(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.db.Tokens[token]; ok {
		delete(s.db.Tokens, token)
		s.scheduleSave()
	}
}

// SnapshotUser — копия пользователя для безопасной передачи между горутинами.
func (s *Store) SnapshotUser(id int64) *User {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u := s.db.Users[id]
	if u == nil {
		return nil
	}
	cp := *u
	if u.ReadSeq != nil {
		cp.ReadSeq = make(map[int64]int64, len(u.ReadSeq))
		for k, v := range u.ReadSeq {
			cp.ReadSeq[k] = v
		}
	}
	return &cp
}

// SetPresence — обновить статус/настроение/lastSeen (при status=="off" только lastSeen).
func (s *Store) SetPresence(id int64, status, mood string, lastSeen int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.db.Users[id]
	if u == nil {
		return
	}
	if status != "off" {
		u.Status = status
		u.Mood = mood
	}
	u.LastSeen = lastSeen
	s.scheduleSave()
}

// --- переписки ---

// AppendMsg — добавить сообщение в пару, выделив очередной seq и серверный id (s<seq>).
func (s *Store) AppendMsg(from, to int64, text string, sys bool) Msg {
	return s.appendMsg(from, to, text, sys, "", 0, 0)
}

// AppendSys — AppendMsg с метаданными звонка для sys-записей: сохраняет op,
// второго участника и длительность, чтобы история после перезагрузки собирала
// те же фразы, что и live-кадры.
func (s *Store) AppendSys(from, to int64, text, op string, peer, durMS int64) Msg {
	return s.appendMsg(from, to, text, true, op, peer, durMS)
}

func (s *Store) appendMsg(from, to int64, text string, sys bool, op string, peer, durMS int64) Msg {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := convKey(from, to)
	seq := s.db.NextSeq[key]
	if seq == 0 {
		seq = 1
	}
	m := Msg{Seq: seq, From: from, ID: "s" + strconv.FormatInt(seq, 10), Text: text, Time: time.Now().Unix(), Sys: sys, SysOp: op, Peer: peer, DurMS: durMS}
	s.db.Convs[key] = append(s.db.Convs[key], m)
	s.db.NextSeq[key] = seq + 1
	s.scheduleSave()
	return m
}

// History — последние limit сообщений пары строго раньше seq before (before=0 → с конца).
func (s *Store) History(a, b int64, before int64, limit int) ([]Msg, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	key := convKey(a, b)
	all := s.db.Convs[key]
	idx := len(all)
	if before > 0 {
		// бинарный поиск первой позиции с Seq >= before
		lo, hi := 0, len(all)
		for lo < hi {
			mid := (lo + hi) / 2
			if all[mid].Seq < before {
				lo = mid + 1
			} else {
				hi = mid
			}
		}
		idx = lo
	}
	start := idx - limit
	hasMore := start > 0
	if start < 0 {
		start = 0
	}
	out := make([]Msg, idx-start)
	copy(out, all[start:idx])
	return out, hasMore
}

// UnreadCount — число сообщений в паре с seq > прочитанного получателем.
func (s *Store) UnreadCount(owner, peer int64) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	key := convKey(owner, peer)
	all := s.db.Convs[key]
	read := int64(0)
	if u := s.db.Users[owner]; u != nil && u.ReadSeq != nil {
		read = u.ReadSeq[peer]
	}
	n := 0
	for i := len(all) - 1; i >= 0; i-- {
		if all[i].Seq <= read || all[i].From == owner {
			break
		}
		n++
	}
	return n
}

// SetRead — отметить прочитанным до seq включительно; вернуть true, если счётчик сдвинулся.
func (s *Store) SetRead(owner, peer, seq int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	u := s.db.Users[owner]
	if u == nil {
		return false
	}
	if u.ReadSeq == nil {
		u.ReadSeq = map[int64]int64{}
	}
	if u.ReadSeq[peer] >= seq {
		return false
	}
	u.ReadSeq[peer] = seq
	s.scheduleSave()
	return true
}

// LastSeqByPeer — последний seq каждой переписки юзера (для вычисления unread после setRead).
func (s *Store) LastSeqByPeer(uid int64) map[int64]int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[int64]int64{}
	for _, u := range s.db.Users {
		if u.ID == uid {
			continue
		}
		key := convKey(uid, u.ID)
		if msgs := s.db.Convs[key]; len(msgs) > 0 {
			out[u.ID] = msgs[len(msgs)-1].Seq
		}
	}
	return out
}

// --- очередь звонков оффлайн-юзерам (хранится только в памяти) ---

// queuedCall — ожидающий звонок для оффлайн-адресата.
type queuedCall struct {
	From   int64
	CallID string
	SDP    string
	Note   string
}

// callQueue — потокобезопасная очередь звонков по uid адресата.
type callQueue struct {
	mu sync.Mutex
	m  map[int64][]queuedCall
}

func newCallQueue() *callQueue { return &callQueue{m: map[int64][]queuedCall{}} }

// push — добавить звонок в конец очереди адресата.
func (q *callQueue) push(uid int64, c queuedCall) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.m[uid] = append(q.m[uid], c)
}

// popAll — забрать всю очередь адресата (FIFO).
func (q *callQueue) popAll(uid int64) []queuedCall {
	q.mu.Lock()
	defer q.mu.Unlock()
	out := q.m[uid]
	delete(q.m, uid)
	return out
}

// removeByCaller — вынуть из очереди адресата конкретный звонок конкретного вызывающего.
func (q *callQueue) removeByCaller(uid, caller int64, callID string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	list := q.m[uid]
	for i, c := range list {
		if c.CallID == callID && c.From == caller {
			q.m[uid] = append(list[:i:i], list[i+1:]...)
			return true
		}
	}
	return false
}

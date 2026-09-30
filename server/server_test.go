package main

// Интеграционные тесты: REST + WebSocket + звонковая семантика + эхо-бот + CORS.
// WS-клиент самодельный (wsDial из ws.go), сервер поднимается через httptest.NewServer.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// --- тестовый каркас ---

// testServer — сервер с чистой базой во временном каталоге.
type testServer struct {
	ts    *httptest.Server
	store *Store
	hub   *Hub
}

// newTestServer — сервер с сидом демо-юзеров.
func newTestServer(t *testing.T) *testServer {
	return newTestServerSeed(t, true)
}

// newTestServerSeed — поднять сервер; seed=true создаёт демо-юзеров и бота.
func newTestServerSeed(t *testing.T, seed bool) *testServer {
	t.Helper()
	store, err := newStore(t.TempDir() + "/db.json")
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	t.Cleanup(func() { store.close() })
	if seed {
		seedDemoUsers(store)
		ensureBotOnline(store)
	}
	hub := newHub(store)
	api := &apiServer{store: store, hub: hub}
	mux := http.NewServeMux()
	api.registerRoutes(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return &testServer{ts: ts, store: store, hub: hub}
}

// login — POST /api/login демо-юзера (пароль demo1234).
func (s *testServer) login(t *testing.T, name string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"name": name, "password": "demo1234"})
	resp, err := http.Post(s.ts.URL+"/api/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("login %s: %v", name, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("login %s: статус %d", name, resp.StatusCode)
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("login decode: %v", err)
	}
	return out.Token
}

// register — POST /api/register нового юзера, возвращает (id, token).
func (s *testServer) register(t *testing.T, name string) (int64, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"name": name, "password": "pass1234", "avatar": 1})
	resp, err := http.Post(s.ts.URL+"/api/register", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("register: статус %d", resp.StatusCode)
	}
	var out struct {
		Token string `json:"token"`
		User  struct {
			ID int64 `json:"id"`
		} `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("register decode: %v", err)
	}
	return out.User.ID, out.Token
}

// dial — WS-подключение от имени юзера; первый кадр (hello) читается сразу.
func (s *testServer) dial(t *testing.T, token string) *wsClient {
	t.Helper()
	ws, err := wsDial(s.ts.URL + "/ws?token=" + token)
	if err != nil {
		t.Fatalf("wsDial: %v", err)
	}
	c := &wsClient{conn: ws}
	var hello outHello
	c.read(t, &hello)
	c.Hello = &hello
	return c
}

// getJSON — GET с Bearer-токеном → (статус, тело).
func (s *testServer) getJSON(t *testing.T, path, token string) (int, []byte) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, s.ts.URL+path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("getJSON %s: %v", path, err)
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(resp.Body)
	return resp.StatusCode, buf.Bytes()
}

// uid — id юзера по имени (из store, тесты живут в том же пакете).
func (s *testServer) uid(name string) int64 {
	return s.store.UserByName(name).ID
}

// wsClient — обертка WS-соединения для тестов.
type wsClient struct {
	conn  *WSConn
	Hello *outHello

	mu  sync.Mutex
	log []map[string]any // журнал прочитанных кадров (для отладки)
}

// send — отправить JSON-кадр.
func (c *wsClient) send(t *testing.T, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("send marshal: %v", err)
	}
	if err := c.conn.WriteText(b); err != nil {
		t.Fatalf("send: %v", err)
	}
}

// read — прочитать следующий текстовый кадр в v (с таймаутом 5с).
func (c *wsClient) read(t *testing.T, v any) {
	t.Helper()
	_ = c.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	op, data, err := c.conn.ReadFrame()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if op != opText {
		t.Fatalf("read: неожиданный опкод %d (данные: %s)", op, data)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("read unmarshal %s: %v", data, err)
	}
	c.mu.Lock()
	var m map[string]any
	_ = json.Unmarshal(data, &m)
	c.log = append(c.log, m)
	c.mu.Unlock()
}

// expect — дождаться кадра с type==want (прочие типы пропускаются).
func (c *wsClient) expect(t *testing.T, want string) map[string]any {
	t.Helper()
	for {
		var m map[string]any
		c.read(t, &m)
		if m["type"] == want {
			return m
		}
	}
}

// close — закрыть соединение.
func (c *wsClient) close() { _ = c.conn.Close() }

// --- REST ---

// TestRESTRegisterLogin — регистрация, дубль имени, валидация, логин, неверный пароль, logout.
func TestRESTRegisterLogin(t *testing.T) {
	s := newTestServerSeed(t, false)

	// Регистрация: 200 + токен + user.
	body, _ := json.Marshal(map[string]any{"name": "Вова", "password": "secret1", "avatar": 2})
	resp, err := http.Post(s.ts.URL+"/api/register", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	var reg struct {
		Token string `json:"token"`
		User  struct {
			ID     int64  `json:"id"`
			Name   string `json:"name"`
			Avatar int    `json:"avatar"`
		} `json:"user"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&reg)
	resp.Body.Close()
	if resp.StatusCode != 200 || reg.Token == "" || reg.User.ID == 0 || reg.User.Name != "Вова" || reg.User.Avatar != 2 {
		t.Fatalf("register: статус %d, ответ %+v", resp.StatusCode, reg)
	}

	// Дубль имени без учёта регистра → 409.
	body, _ = json.Marshal(map[string]any{"name": "вова", "password": "other123", "avatar": 0})
	resp, _ = http.Post(s.ts.URL+"/api/register", "application/json", bytes.NewReader(body))
	resp.Body.Close()
	if resp.StatusCode != 409 {
		t.Fatalf("register dup: ждём 409, получили %d", resp.StatusCode)
	}

	// Короткое имя → 400.
	body, _ = json.Marshal(map[string]any{"name": "В", "password": "secret1", "avatar": 0})
	resp, _ = http.Post(s.ts.URL+"/api/register", "application/json", bytes.NewReader(body))
	resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("register short name: ждём 400, получили %d", resp.StatusCode)
	}

	// Неверный avatar → 400.
	body, _ = json.Marshal(map[string]any{"name": "Гоша", "password": "secret1", "avatar": 9})
	resp, _ = http.Post(s.ts.URL+"/api/register", "application/json", bytes.NewReader(body))
	resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("register bad avatar: ждём 400, получили %d", resp.StatusCode)
	}

	// Логин: верный пароль → 200.
	body, _ = json.Marshal(map[string]string{"name": "Вова", "password": "secret1"})
	resp, _ = http.Post(s.ts.URL+"/api/login", "application/json", bytes.NewReader(body))
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("login: ждём 200, получили %d", resp.StatusCode)
	}

	// Логин: неверный пароль → 401.
	body, _ = json.Marshal(map[string]string{"name": "Вова", "password": "wrong000"})
	resp, _ = http.Post(s.ts.URL+"/api/login", "application/json", bytes.NewReader(body))
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("login wrong: ждём 401, получили %d", resp.StatusCode)
	}

	// Логин: неизвестное имя → 401.
	body, _ = json.Marshal(map[string]string{"name": "Никто", "password": "whatever1"})
	resp, _ = http.Post(s.ts.URL+"/api/login", "application/json", bytes.NewReader(body))
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("login unknown: ждём 401, получили %d", resp.StatusCode)
	}

	// /api/me: по токену — 200, без токена — 401.
	code, raw := s.getJSON(t, "/api/me", reg.Token)
	if code != 200 || !strings.Contains(string(raw), "Вова") {
		t.Fatalf("me: статус %d, тело %s", code, raw)
	}
	if code, _ = s.getJSON(t, "/api/me", ""); code != 401 {
		t.Fatalf("me без токена: ждём 401, получили %d", code)
	}

	// logout → 204, после него токен мёртв.
	req, _ := http.NewRequest(http.MethodPost, s.ts.URL+"/api/logout", nil)
	req.Header.Set("Authorization", "Bearer "+reg.Token)
	resp, _ = http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != 204 {
		t.Fatalf("logout: ждём 204, получили %d", resp.StatusCode)
	}
	if code, _ = s.getJSON(t, "/api/me", reg.Token); code != 401 {
		t.Fatalf("me после logout: ждём 401, получили %d", code)
	}
}

// TestRESTUsersHistory — список юзеров без себя, история с пагинацией, unread в hello.
func TestRESTUsersHistory(t *testing.T) {
	s := newTestServer(t)
	tokA := s.login(t, "Алиса")
	alice, dima := s.uid("Алиса"), s.uid("Дима Билд")

	// /api/users: все, кроме себя (5 = Дима, Хук-хук, Сергей, Катя, бот).
	code, raw := s.getJSON(t, "/api/users", tokA)
	if code != 200 {
		t.Fatalf("users: статус %d", code)
	}
	var users []map[string]any
	if err := json.Unmarshal(raw, &users); err != nil {
		t.Fatalf("users unmarshal: %v", err)
	}
	if len(users) != 5 {
		t.Fatalf("users: ждём 5, получили %d (%s)", len(users), raw)
	}
	var bot map[string]any
	for _, u := range users {
		if u["name"] == "Эхо-бот" {
			bot = u
		}
	}
	if bot == nil || bot["bot"] != true {
		t.Fatalf("users: бот не найден или без bot:true (%v)", bot)
	}

	// Дима шлёт Алисе 3 сообщения (напрямую через store).
	for i := 0; i < 3; i++ {
		s.store.AppendMsg(dima, alice, fmt.Sprintf("msg %d", i), false)
	}
	s.store.SetRead(alice, dima, 2) // Алиса прочитала первые два

	// Полная история.
	code, raw = s.getJSON(t, "/api/history/"+fmt.Sprint(dima), tokA)
	if code != 200 {
		t.Fatalf("history: статус %d", code)
	}
	var hist struct {
		Messages []Msg `json:"messages"`
		HasMore  bool  `json:"hasMore"`
	}
	if err := json.Unmarshal(raw, &hist); err != nil {
		t.Fatalf("history unmarshal: %v", err)
	}
	if len(hist.Messages) != 3 || hist.HasMore {
		t.Fatalf("history: ждём 3 и hasMore=false, получили %d/%v", len(hist.Messages), hist.HasMore)
	}
	if hist.Messages[0].Seq == 0 || hist.Messages[0].ID == "" {
		t.Fatalf("history: пустые seq/id: %+v", hist.Messages[0])
	}

	// Пагинация: before=3 → 2 сообщения.
	code, raw = s.getJSON(t, fmt.Sprintf("/api/history/%d?before=3", dima), tokA)
	if code != 200 {
		t.Fatalf("history before: статус %d", code)
	}
	if err := json.Unmarshal(raw, &hist); err != nil {
		t.Fatalf("history before unmarshal: %v", err)
	}
	if len(hist.Messages) != 2 {
		t.Fatalf("history before=3: ждём 2, получили %d", len(hist.Messages))
	}

	// История с несуществующим юзером → 404.
	if code, _ = s.getJSON(t, "/api/history/999", tokA); code != 404 {
		t.Fatalf("history 999: ждём 404, получили %d", code)
	}

	// hello.unread: 1 непрочитанное от Димы.
	ws := s.dial(t, tokA)
	defer ws.close()
	if n := ws.Hello.Unread[fmt.Sprint(dima)]; n != 1 {
		t.Fatalf("hello.unread: ждём 1 от Димы, получили %v (карта %v)", n, ws.Hello.Unread)
	}
}

// --- WebSocket ---

// TestWSBadToken — неверный токен → close 4001.
func TestWSBadToken(t *testing.T) {
	s := newTestServerSeed(t, false)
	ws, err := wsDial(s.ts.URL + "/ws?token=garbage")
	if err != nil {
		t.Fatalf("wsDial: %v", err)
	}
	defer ws.Close()
	_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	op, data, err := ws.ReadFrame()
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if op != opClose {
		t.Fatalf("ждём close-кадр, получили опкод %d", op)
	}
	if len(data) < 2 {
		t.Fatalf("close-кадр без кода: %v", data)
	}
	if code := int(data[0])<<8 | int(data[1]); code != 4001 {
		t.Fatalf("ждём close 4001, получили %d", code)
	}
}

// TestWSMsgFlow — два клиента: hello, msg+sent+msg, typing, read, presence, unread.
func TestWSMsgFlow(t *testing.T) {
	s := newTestServer(t)
	tokA, tokD := s.login(t, "Алиса"), s.login(t, "Дима Билд")
	alice, dima := s.uid("Алиса"), s.uid("Дима Билд")

	a := s.dial(t, tokA)
	defer a.close()
	d := s.dial(t, tokD)
	defer d.close()

	// В hello Димы Алиса уже в сети.
	found := false
	for _, u := range d.Hello.Users {
		if u.ID == alice {
			found = u.Status == "on"
		}
	}
	if !found {
		t.Fatalf("hello Димы: Алиса не on (%v)", d.Hello.Users)
	}

	// typing.
	a.send(t, map[string]any{"type": "typing", "to": dima, "on": true})
	if m := d.expect(t, "typing"); m["from"] != float64(alice) || m["on"] != true {
		t.Fatalf("typing: %+v", m)
	}

	// msg → sent отправителю + msg получателю.
	a.send(t, map[string]any{"type": "msg", "id": "c1", "to": dima, "text": "привет"})
	if sent := a.expect(t, "sent"); sent["id"] != "c1" || sent["sid"] == "" || sent["seq"] == float64(0) {
		t.Fatalf("sent: %+v", sent)
	}
	got := d.expect(t, "msg")
	if got["from"] != float64(alice) || got["text"] != "привет" || got["sys"] != false || got["time"] == float64(0) {
		t.Fatalf("msg получателю: %+v", got)
	}
	seq1 := int64(got["seq"].(float64))

	// read: Дима прочитал до seq1.
	d.send(t, map[string]any{"type": "read", "to": alice, "seq": seq1})
	if m := a.expect(t, "read"); m["by"] != float64(dima) || m["seq"] != float64(seq1) {
		t.Fatalf("read: %+v", m)
	}

	// Второе сообщение: seq в переписке возрастает.
	a.send(t, map[string]any{"type": "msg", "id": "c2", "to": dima, "text": "как дела"})
	a.expect(t, "sent")
	if got = d.expect(t, "msg"); int64(got["seq"].(float64)) != seq1+1 {
		t.Fatalf("seq не возрастает: %v после %d", got["seq"], seq1)
	}

	// Смена статуса Димой → presence всем.
	d.send(t, map[string]any{"type": "presence", "status": "dnd", "mood": "работаю"})
	if m := a.expect(t, "presence"); m["id"] != float64(dima) || m["status"] != "dnd" || m["mood"] != "работаю" {
		t.Fatalf("presence dnd: %+v", m)
	}

	// Невидимка: Дима ставит inv → для остальных он off.
	d.send(t, map[string]any{"type": "presence", "status": "inv", "mood": ""})
	if m := a.expect(t, "presence"); m["status"] != "off" {
		t.Fatalf("presence inv: ждём off для остальных, получили %+v", m)
	}
	d.send(t, map[string]any{"type": "presence", "status": "on", "mood": ""})
	a.expect(t, "presence")

	// Отключение Димы → presence off.
	d.close()
	if m := a.expect(t, "presence"); m["id"] != float64(dima) || m["status"] != "off" {
		t.Fatalf("presence off: %+v", m)
	}

	// Ещё одно сообщение офлайн + повторный коннект Димы: unread = 2.
	a.send(t, map[string]any{"type": "msg", "id": "c3", "to": dima, "text": "эй"})
	a.expect(t, "sent")
	d2 := s.dial(t, tokD)
	defer d2.close()
	if n := d2.Hello.Unread[fmt.Sprint(alice)]; n != 2 {
		t.Fatalf("unread после reconnect: ждём 2, получили %v", n)
	}
}

// TestWSReconnectKicksOld — новое подключение того же юзера закрывает старое.
func TestWSReconnectKicksOld(t *testing.T) {
	s := newTestServer(t)
	tokA := s.login(t, "Алиса")

	a1 := s.dial(t, tokA)
	a2 := s.dial(t, tokA)
	defer a2.close()

	// Старое соединение получает close(1000).
	_ = a1.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	op, _, err := a1.conn.ReadFrame()
	if err != nil {
		t.Fatalf("старое соединение: %v", err)
	}
	if op != opClose {
		t.Fatalf("старое соединение: ждём close, получили опкод %d", op)
	}
	a1.close()

	// Новое соединение живо: сообщение доходит до Димы.
	tokD := s.login(t, "Дима Билд")
	d := s.dial(t, tokD)
	defer d.close()
	a2.send(t, map[string]any{"type": "msg", "id": "k1", "to": s.uid("Дима Билд"), "text": "новое соединение"})
	a2.expect(t, "sent")
	if m := d.expect(t, "msg"); m["text"] != "новое соединение" {
		t.Fatalf("msg: %+v", m)
	}
}

// TestWSFrameEdgeCases — фрагментация (с пингом между фрагментами) и длина 126/127.
func TestWSFrameEdgeCases(t *testing.T) {
	s := newTestServer(t)
	tokA, tokD := s.login(t, "Алиса"), s.login(t, "Дима Билд")
	dima := s.uid("Дима Билд")

	a := s.dial(t, tokA)
	defer a.close()
	d := s.dial(t, tokD)
	defer d.close()

	// Фрагментированное сообщение + пинг между фрагментами.
	full := `{"type":"msg","id":"f1","to":` + fmt.Sprint(dima) + `,"text":"фрагментированное сообщение"}`
	writeRawFrame(a, false, opText, []byte(full[:20]))
	writeRawFrame(a, true, opPing, []byte("x")) // контрольный кадр между фрагментами
	writeRawFrame(a, false, opContinuation, []byte(full[20:40]))
	writeRawFrame(a, true, opContinuation, []byte(full[40:]))
	a.expect(t, "sent")
	if m := d.expect(t, "msg"); m["text"] != "фрагментированное сообщение" {
		t.Fatalf("фрагментированное msg: %+v", m)
	}

	// Кадр с 64-битной длиной (127): 60000 символов — сервер отклонит (лимит 4000),
	// но соединение должно выжить: следующее валидное сообщение обрабатывается.
	big := strings.Repeat("а", 60000)
	a.send(t, map[string]any{"type": "msg", "id": "big", "to": dima, "text": big})
	a.send(t, map[string]any{"type": "msg", "id": "after", "to": dima, "text": "после большого"})
	if m := a.expect(t, "sent"); m["id"] != "after" {
		t.Fatalf("после 127-кадра: ждём ack 'after', получили %+v", m)
	}
	if m := d.expect(t, "msg"); m["text"] != "после большого" {
		t.Fatalf("после 127-кадра: получателю %+v", m)
	}
}

// writeRawFrame — ручная запись клиентского кадра (маска, произвольный FIN/опкод).
func writeRawFrame(c *wsClient, fin bool, op int, payload []byte) {
	h0 := byte(op)
	if fin {
		h0 |= 0x80
	}
	if len(payload) > 125 {
		panic("writeRawFrame: тестовый хелпер только для коротких кадров")
	}
	var mask [4]byte = [4]byte{7, 91, 13, 222}
	buf := []byte{h0, 0x80 | byte(len(payload))}
	buf = append(buf, mask[:]...)
	for i, b := range payload {
		buf = append(buf, b^mask[i&3])
	}
	_, _ = c.conn.conn.Write(buf) // прямой доступ к net.Conn (тесты в том же пакете)
}

// --- звонки ---

// TestCallOfferAnswerICE — активный звонок: offer/answer/ice ходят, end пишет sys.
func TestCallOfferAnswerICE(t *testing.T) {
	s := newTestServer(t)
	tokA, tokD := s.login(t, "Алиса"), s.login(t, "Дима Билд")
	alice, dima := s.uid("Алиса"), s.uid("Дима Билд")

	a := s.dial(t, tokA)
	defer a.close()
	d := s.dial(t, tokD)
	defer d.close()

	// offer.
	a.send(t, map[string]any{"type": "call", "op": "offer", "to": dima, "callID": "c1", "sdp": "offer-sdp"})
	m := d.expect(t, "call")
	if m["op"] != "offer" || m["from"] != float64(alice) || m["callID"] != "c1" || m["sdp"] != "offer-sdp" || m["note"] != "" {
		t.Fatalf("offer: %+v", m)
	}

	// answer.
	d.send(t, map[string]any{"type": "call", "op": "answer", "to": alice, "callID": "c1", "sdp": "answer-sdp"})
	if m = a.expect(t, "call"); m["op"] != "answer" || m["from"] != float64(dima) || m["sdp"] != "answer-sdp" {
		t.Fatalf("answer: %+v", m)
	}

	// ice в обе стороны.
	cand := map[string]any{"candidate": "cand1", "sdpMid": "0", "sdpMLineIndex": 0}
	a.send(t, map[string]any{"type": "call", "op": "ice", "to": dima, "callID": "c1", "cand": cand})
	if m = d.expect(t, "call"); m["op"] != "ice" || m["from"] != float64(alice) {
		t.Fatalf("ice: %+v", m)
	}
	gotCand, _ := m["cand"].(map[string]any)
	if gotCand["candidate"] != "cand1" || gotCand["sdpMLineIndex"] != float64(0) {
		t.Fatalf("ice cand: %+v", m["cand"])
	}
	d.send(t, map[string]any{"type": "call", "op": "ice", "to": alice, "callID": "c1", "cand": cand})
	if m = a.expect(t, "call"); m["op"] != "ice" || m["from"] != float64(dima) {
		t.Fatalf("ice обратно: %+v", m)
	}

	// end: Диме end-кадр, обоим sys-сообщение.
	a.send(t, map[string]any{"type": "call", "op": "end", "to": dima, "callID": "c1"})
	if m = d.expect(t, "call"); m["op"] != "end" || m["from"] != float64(alice) || m["callID"] != "c1" {
		t.Fatalf("end: %+v", m)
	}
	if m = a.expect(t, "msg"); m["sys"] != true || m["text"] != sysEnd {
		t.Fatalf("sys после end у вызывающего: %+v", m)
	}
	if m = d.expect(t, "msg"); m["sys"] != true || m["text"] != sysEnd {
		t.Fatalf("sys после end у адресата: %+v", m)
	}

	// После end можно звонить снова.
	a.send(t, map[string]any{"type": "call", "op": "offer", "to": dima, "callID": "c2", "sdp": "again"})
	if m = d.expect(t, "call"); m["op"] != "offer" || m["callID"] != "c2" {
		t.Fatalf("повторный offer: %+v", m)
	}
	a.send(t, map[string]any{"type": "call", "op": "cancel", "to": dima, "callID": "c2"})
	d.expect(t, "call")
}

// TestCallBusy — входящий второму звонящему, пока абонент занят → busy.
func TestCallBusy(t *testing.T) {
	s := newTestServer(t)
	tokA, tokD, tokK := s.login(t, "Алиса"), s.login(t, "Дима Билд"), s.login(t, "Катя")
	dima := s.uid("Дима Билд")

	a := s.dial(t, tokA)
	defer a.close()
	d := s.dial(t, tokD)
	defer d.close()
	k := s.dial(t, tokK)
	defer k.close()

	// Алиса звонит Диме.
	a.send(t, map[string]any{"type": "call", "op": "offer", "to": dima, "callID": "x1", "sdp": "sdp-a"})
	if m := d.expect(t, "call"); m["op"] != "offer" || m["callID"] != "x1" {
		t.Fatalf("offer: %+v", m)
	}

	// Катя звонит занятому Диме → busy (без sys; фронт рисует строку сам).
	k.send(t, map[string]any{"type": "call", "op": "offer", "to": dima, "callID": "x2", "sdp": "sdp-k"})
	if m := k.expect(t, "call"); m["op"] != "busy" || m["from"] != float64(dima) || m["callID"] != "x2" {
		t.Fatalf("busy: %+v", m)
	}
}

// TestCallReject — отклонение: reject + sys «Звонок отклонён» обеим сторонам.
func TestCallReject(t *testing.T) {
	s := newTestServer(t)
	tokA, tokD := s.login(t, "Алиса"), s.login(t, "Дима Билд")
	alice, dima := s.uid("Алиса"), s.uid("Дима Билд")

	a := s.dial(t, tokA)
	defer a.close()
	d := s.dial(t, tokD)
	defer d.close()

	a.send(t, map[string]any{"type": "call", "op": "offer", "to": dima, "callID": "r1", "sdp": "sdp"})
	d.expect(t, "call")
	d.send(t, map[string]any{"type": "call", "op": "reject", "to": alice, "callID": "r1"})

	if m := a.expect(t, "call"); m["op"] != "reject" || m["from"] != float64(dima) {
		t.Fatalf("reject: %+v", m)
	}

	// После reject линии свободны: обратный звонок проходит.
	d.send(t, map[string]any{"type": "call", "op": "offer", "to": alice, "callID": "r2", "sdp": "sdp2"})
	if m := a.expect(t, "call"); m["op"] != "offer" || m["callID"] != "r2" {
		t.Fatalf("offer после reject: %+v", m)
	}
}

// TestCallCancel — отмена вызывающим: cancel + sys «Вы отменили звонок».
func TestCallCancel(t *testing.T) {
	s := newTestServer(t)
	tokA, tokD := s.login(t, "Алиса"), s.login(t, "Дима Билд")
	alice, dima := s.uid("Алиса"), s.uid("Дима Билд")

	a := s.dial(t, tokA)
	defer a.close()
	d := s.dial(t, tokD)
	defer d.close()

	a.send(t, map[string]any{"type": "call", "op": "offer", "to": dima, "callID": "cn1", "sdp": "sdp"})
	d.expect(t, "call")
	a.send(t, map[string]any{"type": "call", "op": "cancel", "to": dima, "callID": "cn1"})

	if m := d.expect(t, "call"); m["op"] != "cancel" || m["from"] != float64(alice) {
		t.Fatalf("cancel: %+v", m)
	}
}

// TestCallOfflineQueued — звонок оффлайн-юзеру: queued → offer при его входе → answer.
func TestCallOfflineQueued(t *testing.T) {
	s := newTestServer(t)
	tokA, tokD := s.login(t, "Алиса"), s.login(t, "Дима Билд")
	alice, dima := s.uid("Алиса"), s.uid("Дима Билд")

	a := s.dial(t, tokA)
	defer a.close()

	// Дима оффлайн → queued.
	a.send(t, map[string]any{"type": "call", "op": "offer", "to": dima, "callID": "q1", "sdp": "queued-sdp"})
	qm := a.expect(t, "call")
	if qm["op"] != "queued" || qm["callID"] != "q1" {
		t.Fatalf("queued: %+v", qm)
	}
	if _, hasFrom := qm["from"]; hasFrom {
		t.Fatalf("queued не должен содержать from: %+v", qm)
	}

	// Дима заходит в сеть → ему доносится offer.
	d := s.dial(t, tokD)
	defer d.close()
	if m := d.expect(t, "call"); m["op"] != "offer" || m["from"] != float64(alice) || m["sdp"] != "queued-sdp" {
		t.Fatalf("offer после входа: %+v", m)
	}

	// Ответ уходит вызывающему.
	d.send(t, map[string]any{"type": "call", "op": "answer", "to": alice, "callID": "q1", "sdp": "ans"})
	if m := a.expect(t, "call"); m["op"] != "answer" || m["sdp"] != "ans" {
		t.Fatalf("answer: %+v", m)
	}

	// Завершение.
	a.send(t, map[string]any{"type": "call", "op": "end", "to": dima, "callID": "q1"})
	if m := d.expect(t, "call"); m["op"] != "end" {
		t.Fatalf("end: %+v", m)
	}
	a.expect(t, "msg") // sys «Звонок завершён»
}

// TestCallCancelWhileQueued — cancel звонка, висящего в очереди.
func TestCallCancelWhileQueued(t *testing.T) {
	s := newTestServer(t)
	tokA, tokD := s.login(t, "Алиса"), s.login(t, "Дима Билд")
	dima := s.uid("Дима Билд")

	a := s.dial(t, tokA)
	defer a.close()

	a.send(t, map[string]any{"type": "call", "op": "offer", "to": dima, "callID": "qc1", "sdp": "sdp"})
	a.expect(t, "call") // queued
	a.send(t, map[string]any{"type": "call", "op": "cancel", "to": dima, "callID": "qc1"})
	a.expect(t, "call") // cancel возвращается вызывающему из очереди

	// Дима заходит — звонка уже нет, только presence.
	d := s.dial(t, tokD)
	defer d.close()
	_ = d.conn.SetReadDeadline(time.Now().Add(400 * time.Millisecond))
	op, data, err := d.conn.ReadFrame()
	if err == nil && op == opText {
		var m map[string]any
		_ = json.Unmarshal(data, &m)
		if m["type"] == "call" {
			t.Fatalf("отменённый звонок доставлен: %+v", m)
		}
	}
	_ = d.conn.SetReadDeadline(time.Time{})
}

// TestCallTimeoutMissed — 45с (в тесте 300мс) без ответа → «Пропущенный звонок» + end.
func TestCallTimeoutMissed(t *testing.T) {
	s := newTestServer(t)
	s.hub.callTimeout = 300 * time.Millisecond
	tokA, tokD := s.login(t, "Алиса"), s.login(t, "Дима Билд")
	alice, dima := s.uid("Алиса"), s.uid("Дима Билд")

	a := s.dial(t, tokA)
	defer a.close()
	d := s.dial(t, tokD)
	defer d.close()

	a.send(t, map[string]any{"type": "call", "op": "offer", "to": dima, "callID": "t1", "sdp": "sdp"})
	if m := d.expect(t, "call"); m["op"] != "offer" {
		t.Fatalf("offer: %+v", m)
	}

	// Никто не отвечает: обе стороны получают sys «Пропущенный звонок» и end.
	if m := a.expect(t, "msg"); m["sys"] != true || m["text"] != sysMissed {
		t.Fatalf("missed у вызывающего: %+v", m)
	}
	if m := a.expect(t, "call"); m["op"] != "end" || m["from"] != float64(dima) {
		t.Fatalf("end у вызывающего: %+v", m)
	}
	if m := d.expect(t, "msg"); m["sys"] != true || m["text"] != sysMissed {
		t.Fatalf("missed у адресата: %+v", m)
	}
	if m := d.expect(t, "call"); m["op"] != "end" || m["from"] != float64(alice) {
		t.Fatalf("end у адресата: %+v", m)
	}

	// Линии свободны: повторный звонок проходит.
	a.send(t, map[string]any{"type": "call", "op": "offer", "to": dima, "callID": "t2", "sdp": "sdp"})
	if m := d.expect(t, "call"); m["op"] != "offer" && m["callID"] != "t2" {
		t.Fatalf("offer после missed: %+v", m)
	}
}

// TestCallDisconnectEndsCall — разрыв соединения участника → end второй стороне.
func TestCallDisconnectEndsCall(t *testing.T) {
	s := newTestServer(t)
	tokA, tokD := s.login(t, "Алиса"), s.login(t, "Дима Билд")
	dima := s.uid("Дима Билд")

	a := s.dial(t, tokA)
	defer a.close()
	d := s.dial(t, tokD)

	a.send(t, map[string]any{"type": "call", "op": "offer", "to": dima, "callID": "dc1", "sdp": "sdp"})
	d.expect(t, "call")

	// Дима резко обрывает соединение → Алисе прилетает end.
	d.close()
	if m := a.expect(t, "call"); m["op"] != "end" || m["callID"] != "dc1" {
		t.Fatalf("end после разрыва: %+v", m)
	}
	// Наличие sys о разрыве не проверяем: звонок не был принят.
}

// --- эхо-бот ---

// TestEchoBot — typing on → эхо → typing off; звонок боту → busy.
func TestEchoBot(t *testing.T) {
	s := newTestServer(t)
	tokA := s.login(t, "Алиса")
	bot := s.uid("Эхо-бот")

	a := s.dial(t, tokA)
	defer a.close()

	// Бот в hello со статусом on и флагом bot.
	var botInfo *outUser
	for i, u := range a.Hello.Users {
		if u.ID == bot {
			botInfo = &a.Hello.Users[i]
		}
	}
	if botInfo == nil || botInfo.Bot != true || botInfo.Status != "on" {
		t.Fatalf("hello: бот не найден/не on: %+v", botInfo)
	}

	// Сообщение боту → sent, typing on, эхо, typing off.
	a.send(t, map[string]any{"type": "msg", "id": "b1", "to": bot, "text": "привет бот"})
	a.expect(t, "sent")
	if m := a.expect(t, "typing"); m["from"] != float64(bot) || m["on"] != true {
		t.Fatalf("typing on от бота: %+v", m)
	}
	if m := a.expect(t, "msg"); m["from"] != float64(bot) || m["text"] != "Эхо: привет бот" {
		t.Fatalf("эхо бота: %+v", m)
	}
	if m := a.expect(t, "typing"); m["from"] != float64(bot) || m["on"] != false {
		t.Fatalf("typing off от бота: %+v", m)
	}

	// Звонок боту → busy (без sys).
	a.send(t, map[string]any{"type": "call", "op": "offer", "to": bot, "callID": "bt1", "sdp": "sdp"})
	if m := a.expect(t, "call"); m["op"] != "busy" || m["from"] != float64(bot) {
		t.Fatalf("звонок боту: %+v", m)
	}

	// Эхо бота попадает в историю переписки с ним.
	code, raw := s.getJSON(t, "/api/history/"+fmt.Sprint(bot), tokA)
	if code != 200 || !strings.Contains(string(raw), "Эхо: привет бот") {
		t.Fatalf("история с ботом: %d %s", code, raw)
	}
}

// --- CORS и health ---

// TestCORS — preflight и заголовки на /api/* и /ws, health.
func TestCORS(t *testing.T) {
	s := newTestServer(t)

	// Preflight на /api/register.
	req, _ := http.NewRequest(http.MethodOptions, s.ts.URL+"/api/register", nil)
	req.Header.Set("Origin", "tauri://localhost")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("preflight register: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("preflight register: ждём 204, получили %d", resp.StatusCode)
	}
	if resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("preflight register: нет ACAO *")
	}

	// Preflight на /ws.
	req, _ = http.NewRequest(http.MethodOptions, s.ts.URL+"/ws", nil)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("preflight ws: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent || resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("preflight ws: статус %d, ACAO %q", resp.StatusCode, resp.Header.Get("Access-Control-Allow-Origin"))
	}

	// Обычный ответ тоже с CORS-заголовком.
	body, _ := json.Marshal(map[string]string{"name": "Алиса", "password": "demo1234"})
	resp, err = http.Post(s.ts.URL+"/api/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("login CORS: статус %d, ACAO %q", resp.StatusCode, resp.Header.Get("Access-Control-Allow-Origin"))
	}

	// Health.
	resp, err = http.Get(s.ts.URL + "/health")
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(resp.Body)
	if resp.StatusCode != 200 || buf.String() != "ok" {
		t.Fatalf("health: %d %q", resp.StatusCode, buf.String())
	}
}

// TestCallDisconnectGraceTalk — обрыв WS в активном разговоре НЕ гасит звонок:
// грейс-период ждёт реконнекта; вернувшийся участник продолжает разговор.
func TestCallDisconnectGraceTalk(t *testing.T) {
	s := newTestServer(t)
	s.hub.callGrace = 400 * time.Millisecond
	tokA, tokD := s.login(t, "Алиса"), s.login(t, "Дима Билд")
	dima := s.uid("Дима Билд")

	a := s.dial(t, tokA)
	defer a.close()
	d := s.dial(t, tokD)
	defer d.close()

	a.send(t, map[string]any{"type": "call", "op": "offer", "to": dima, "callID": "g1", "sdp": "sdp"})
	d.expect(t, "call")
	d.send(t, map[string]any{"type": "call", "op": "answer", "to": s.uid("Алиса"), "callID": "g1", "sdp": "sdp"})
	a.expect(t, "call")

	// Дима «свернул приложение»: WS оборван, но разговор уже идёт (answer был).
	d.close()
	// Алисе НЕ прилетает end за грейс-период: сразу после обрыва служебных
	// кадров быть не должно (допустимы только pong на наши пинги).
	_ = a.conn.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
	for {
		op, data, err := a.conn.ReadFrame()
		if err != nil {
			break // тишина — то, что нужно
		}
		var m map[string]any
		if op == opText {
			_ = json.Unmarshal(data, &m)
		}
		if op == opText && m["type"] == "call" {
			t.Fatalf("не ждали call-кадра сразу после обрыва: %+v", m)
		}
	}

	// Дима вернулся (новый WS) до истечения грейса: звонок продолжается —
	// ICE от Димы релеится Алисе, end за reconnect не пришёл.
	_ = a.conn.SetReadDeadline(time.Now().Add(5 * time.Second)) // обычный тестовый дедлайн
	d2 := s.dial(t, tokD)                                       // dial сам вычитывает hello
	d2.send(t, map[string]any{"type": "call", "op": "ice", "to": s.uid("Алиса"), "callID": "g1", "cand": map[string]any{"candidate": "x"}})
	if m := a.expect(t, "call"); m["op"] != "ice" {
		t.Fatalf("ice после реконнекта: %+v", m)
	}
}

// TestCallGraceExpires — грейс-период истёк, но собеседник (Алиса) онлайн:
// звонок НЕ гасится (медиа идёт P2P, Алиса завершит кнопкой или дождётся
// возвращения Димы). Проверяем, что end не пришло и сигналинг продолжает работать.
func TestCallGraceExpires(t *testing.T) {
	s := newTestServer(t)
	s.hub.callGrace = 250 * time.Millisecond
	tokA, tokD := s.login(t, "Алиса"), s.login(t, "Дима Билд")
	dima := s.uid("Дима Билд")

	a := s.dial(t, tokA)
	defer a.close()
	d := s.dial(t, tokD)

	a.send(t, map[string]any{"type": "call", "op": "offer", "to": dima, "callID": "g2", "sdp": "sdp"})
	d.expect(t, "call")
	d.send(t, map[string]any{"type": "call", "op": "answer", "to": s.uid("Алиса"), "callID": "g2", "sdp": "sdp"})
	a.expect(t, "call")

	d.close()
	// За грейс и после: Алисе end НЕ прилетает (она онлайн — звонок жив).
	_ = a.conn.SetReadDeadline(time.Now().Add(600 * time.Millisecond))
	for {
		op, data, err := a.conn.ReadFrame()
		if err != nil {
			break // тишина — то, что нужно
		}
		var m map[string]any
		if op == opText {
			_ = json.Unmarshal(data, &m)
		}
		if op == opText && m["type"] == "call" && m["op"] == "end" {
			t.Fatalf("end не должен приходить онлайн-собеседнику: %+v", m)
		}
	}
	_ = a.conn.SetReadDeadline(time.Now().Add(5 * time.Second))

	// Алиса завершает звонок — Дима (оффлайн) не получит кадр, но звонок чистится,
	// и повторный звонок проходит без busy.
	a.send(t, map[string]any{"type": "call", "op": "end", "to": dima, "callID": "g2"})
	if m := a.expect(t, "msg"); m["sys"] != true {
		t.Fatalf("sys после end: %+v", m)
	}
	a.send(t, map[string]any{"type": "call", "op": "offer", "to": dima, "callID": "g3", "sdp": "sdp"})
	// Дима оффлайн → queued
	if m := a.expect(t, "call"); m["op"] != "queued" {
		t.Fatalf("queued после очистки: %+v", m)
	}
}

// TestCallRenegoOfferAnswer — повторные offer/answer (renego:true) внутри
// идущего звонка релеятся и не считаются новым звонком/busy.
func TestCallRenegoOfferAnswer(t *testing.T) {
	s := newTestServer(t)
	tokA, tokD := s.login(t, "Алиса"), s.login(t, "Дима Билд")
	dima := s.uid("Дима Билд")
	alice := s.uid("Алиса")

	a := s.dial(t, tokA)
	defer a.close()
	d := s.dial(t, tokD)
	defer d.close()

	a.send(t, map[string]any{"type": "call", "op": "offer", "to": dima, "callID": "r1", "sdp": "sdp"})
	d.expect(t, "call")
	d.send(t, map[string]any{"type": "call", "op": "answer", "to": alice, "callID": "r1", "sdp": "sdp"})
	a.expect(t, "call")

	// Алиса добавляет видео: повторный offer с renego
	a.send(t, map[string]any{"type": "call", "op": "offer", "to": dima, "callID": "r1", "sdp": "sdp2", "renego": true})
	if m := d.expect(t, "call"); m["op"] != "offer" || m["renego"] != true || m["sdp"] != "sdp2" {
		t.Fatalf("renego offer: %+v", m)
	}
	// Ответ Димы (renego)
	d.send(t, map[string]any{"type": "call", "op": "answer", "to": alice, "callID": "r1", "sdp": "ans2", "renego": true})
	if m := a.expect(t, "call"); m["op"] != "answer" || m["renego"] != true || m["sdp"] != "ans2" {
		t.Fatalf("renego answer: %+v", m)
	}

	// Линия по-прежнему занята: третий звонок Алисе — busy.
	_, tokX := s.register(t, "Третий-"+strconv.FormatInt(time.Now().UnixNano()%1000, 10))
	xw := s.dial(t, tokX)
	defer xw.close()
	xw.send(t, map[string]any{"type": "call", "op": "offer", "to": alice, "callID": "rX", "sdp": "sdp"})
	if m := xw.expect(t, "call"); m["op"] != "busy" {
		t.Fatalf("busy третьему: %+v", m)
	}
}

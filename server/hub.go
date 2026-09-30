package main

// WebSocket-хаб: реестр живых подключений, presence-рассылки, маршрутизация
// msg/typing/read/presence и полная звонковая семантика:
// offer/answer/ice/end/reject/busy/cancel/queued + очередь звонков оффлайн-юзерам.

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"
	"unicode/utf8"
)

// Таймауты и лимиты протокола.
const (
	idleTimeout   = 60 * time.Second // сервер рвёт соединение после 60с тишины
	callTimeout45 = 45 * time.Second // «Пропущенный звонок», если не ответили
	botReplyDelay = 1 * time.Second  // задержка эха бота
	maxTextLen    = 4000             // максимум символов в тексте сообщения
	maxMoodLen    = 60               // максимум символов в настроении
)

// callGrace — сколько секунд активный разговор считается живым после обрыва
// WS у участника (телефон свернули — WebView заморозили, соединение рвётся).
// Если за это время юзер не вернулся (реконнект с тем же звонком), разговор
// завершается обычным end. Медиа идёт P2P и переживает обрыв сигналинга.
const callGrace = 40 * time.Second

// Тексты системных сообщений звонков (по протоколу).
const (
	sysEnd    = "Звонок завершён" // текст-заполнитель; фронт строит фразу по op+peer+dur
	sysMissed = "Пропущенный звонок"
	sysCancel = "Звонок отменён"
	sysReject = "Звонок отклонён"
	sysBusy   = "Абонент занят"
)

// Hub — центральное состояние сервера: подключения, звонки, очередь.
type Hub struct {
	store *Store

	mu     sync.Mutex
	conns  map[int64]*Client      // uid → активное подключение (одно на юзера)
	calls  map[int64]*callEntry   // uid → его текущий звонок (любая роль)
	timers map[string]*time.Timer // callID → таймер «не ответил 45с»
	grace  map[string]*time.Timer // callID → таймер грейс-периода обрыва WS в разговоре
	queue  *callQueue             // offer'ы, ждущие выхода адресата в сеть

	callTimeout time.Duration // переопределяется в тестах
	callGrace   time.Duration // переопределяется в тестах
}

// callEntry — участие юзера в звонке.
type callEntry struct {
	callID    string
	peer      int64
	caller    bool      // true — вызывающий
	queued    bool      // true — offer ждёт выхода адресата в сеть
	answered  bool      // true после answer
	talkStart time.Time // момент answer (для длительности в sys-строке)
	grace     bool      // true — разговор идёт, WS участника оборван (ждём реконнекта)
}

// Client — одно WS-подключение пользователя.
type Client struct {
	hub       *Hub
	uid       int64
	conn      *WSConn
	send      chan []byte   // исходящие кадры (пишет writePump, FIFO)
	done      chan struct{} // закрывается при завершении
	closeOnce sync.Once
}

// newHub — конструктор.
func newHub(store *Store) *Hub {
	return &Hub{
		store:       store,
		conns:       map[int64]*Client{},
		calls:       map[int64]*callEntry{},
		timers:      map[string]*time.Timer{},
		grace:       map[string]*time.Timer{},
		queue:       newCallQueue(),
		callTimeout: callTimeout45,
		callGrace:   callGrace,
	}
}

// --- подключение ---

// handleWS — HTTP-обработчик GET /ws?token=... (плюс CORS-preflight).
func (h *Hub) handleWS(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		setCors(w)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "метод не поддерживается", http.StatusMethodNotAllowed)
		return
	}
	conn, err := wsAccept(w, r)
	if err != nil {
		return // wsAccept уже ответил HTTP-ошибкой
	}
	uid := h.store.TokenUID(r.URL.Query().Get("token"))
	if uid == 0 || h.store.UserByID(uid) == nil {
		// Неверный токен: апгрейд уже выполнен, закрываем кодом 4001.
		_ = conn.WriteClose(4001, "неверный токен")
		time.Sleep(100 * time.Millisecond) // дать close-кадру дойти
		conn.Close()
		return
	}
	h.addClient(uid, conn)
}

// addClient — регистрирует подключение (закрывая старое), шлёт hello первым кадром,
// доставляет очередь звонков и рассылает presence.
func (h *Hub) addClient(uid int64, conn *WSConn) {
	// Валидируем сохранённый статус: после коннекта юзер как минимум online.
	if u := h.store.SnapshotUser(uid); u != nil {
		switch u.Status {
		case "on", "idle", "dnd", "inv":
		default:
			h.store.SetPresence(uid, "on", u.Mood, time.Now().Unix())
		}
	}

	c := &Client{
		hub:  h,
		uid:  uid,
		conn: conn,
		send: make(chan []byte, 256),
		done: make(chan struct{}),
	}

	h.mu.Lock()
	// Новое подключение того же юзера закрывает старое.
	if old := h.conns[uid]; old != nil {
		old.shutdown()
	}
	// Фоновые звонки: если юзер вернулся, а его разговор ещё в грейс-периоде
	// (WS рвался при сворачивании приложения) — НЕ гасим звонок, продолжаем.
	// Иначе гасим lingering-активный звонок (обрыв старого соединения).
	// Queued-записи не трогаем — их доставит deliverQueuedCalls.
	var endPeer int64
	var endCallID string
	hadCall := false
	if e := h.calls[uid]; e != nil && !e.queued && e.grace {
		e.grace = false
		if t := h.grace[e.callID]; t != nil {
			t.Stop()
			delete(h.grace, e.callID)
		}
	} else {
		endPeer, endCallID, hadCall = h.dropActiveCallLocked(uid)
	}
	h.conns[uid] = c
	h.sendHello(c)                  // hello — обязательно первый кадр
	busy := h.deliverQueuedCalls(c) // звонки, накопившиеся за оффлайн
	h.mu.Unlock()

	// Всё, что требует h.mu в своих путях, — после разблокировки.
	if hadCall {
		h.sendTo(endPeer, outCall{Type: "call", Op: "end", From: uid, CallID: endCallID})
	}
	for _, qc := range busy {
		h.sendTo(qc.From, outCall{Type: "call", Op: "busy", From: uid, CallID: qc.CallID})
		h.logSys(qc.From, uid, sysBusy, "busy", uid, 0)
	}
	h.broadcastPresence(uid) // всем остальным: юзер в сети

	go c.writePump()
	go c.readPump()
}

// deliverQueuedCalls — юзер вышел в сеть: первый ожидающий звонок доставляется
// (offer + таймер 45с), остальные (мусорные/дубли) — вызывающим busy (под h.mu).
func (h *Hub) deliverQueuedCalls(c *Client) []queuedCall {
	var busy []queuedCall
	delivered := false
	for _, qc := range h.queue.popAll(c.uid) {
		ce := h.calls[qc.From]
		valid := ce != nil && ce.caller && ce.callID == qc.CallID && ce.queued
		if delivered || !valid {
			if valid {
				delete(h.calls, qc.From) // звонок больше не актуален
			}
			busy = append(busy, qc)
			continue
		}
		// Дозвонился: снимаем флаг очереди, регистрируем адресата, шлём offer.
		ce.queued = false
		h.calls[c.uid] = &callEntry{callID: qc.CallID, peer: qc.From}
		callID := qc.CallID
		h.timers[callID] = time.AfterFunc(h.callTimeout, func() { h.callTimedOut(callID) })
		c.sendFrame(mustJSON(outCallOffer{
			Type: "call", Op: "offer", From: qc.From, CallID: qc.CallID,
			SDP: qc.SDP, Note: qc.Note,
		}))
		delivered = true
	}
	return busy
}

// sendHello — приветственный кадр с моим профилем, списком юзеров и unread.
func (h *Hub) sendHello(c *Client) {
	me := h.store.SnapshotUser(c.uid)
	if me == nil {
		return
	}
	users := []outUser{}
	unread := map[string]int{}
	for _, u := range h.store.SnapshotUsersAll() {
		if u.ID == c.uid {
			continue
		}
		status, lastSeen := h.publicStatusLocked(u)
		users = append(users, outUser{
			ID: u.ID, Name: u.Name, Avatar: u.Avatar,
			Status: status, Mood: u.Mood, LastSeen: lastSeen, Bot: u.Bot,
		})
		unread[strconv.FormatInt(u.ID, 10)] = h.store.UnreadCount(c.uid, u.ID)
	}
	c.sendFrame(mustJSON(outHello{
		Type:   "hello",
		Me:     outUserMe{ID: me.ID, Name: me.Name, Avatar: me.Avatar, Status: me.Status, Mood: me.Mood},
		Users:  users,
		Unread: unread,
	}))
}

// publicStatusLocked — статус/lastSeen юзера глазами остальных (под h.mu):
// inv маскируется в off; реальный оффлайн тоже off; бот всегда on.
func (h *Hub) publicStatusLocked(u *User) (string, int64) {
	if u.Bot {
		return "on", u.LastSeen
	}
	if _, online := h.conns[u.ID]; !online {
		return "off", u.LastSeen
	}
	status := u.Status
	if status == "" {
		status = "on"
	}
	if status == "inv" {
		status = "off"
	}
	return status, time.Now().Unix()
}

// publicStatus — то же для REST (сам берёт лок).
func (h *Hub) publicStatus(u *User) (string, int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.publicStatusLocked(u)
}

// broadcastPresence — рассылка presence всем, кроме самого юзера.
func (h *Hub) broadcastPresence(uid int64) {
	h.mu.Lock()
	u := h.store.SnapshotUser(uid)
	if u == nil {
		h.mu.Unlock()
		return
	}
	status, lastSeen := h.publicStatusLocked(u)
	frame := mustJSON(outPresence{Type: "presence", ID: uid, Status: status, Mood: u.Mood, LastSeen: lastSeen})
	for id, c := range h.conns {
		if id != uid {
			c.sendFrame(frame)
		}
	}
	h.mu.Unlock()
}

// --- циклы клиента ---

// writePump — пишет кадры из канала send, пока не закрыт done.
// Каждые 30с шлёт WS-ping: держит соединение живым (NAT, прокси) и обновляет
// активность даже у молчаливых клиентов (read deadline сбрасывается ответным pong).
func (c *Client) writePump() {
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	for {
		select {
		case b := <-c.send:
			if err := c.conn.WriteText(b); err != nil {
				c.shutdown()
				return
			}
		case <-tick.C:
			if err := c.conn.WriteFrame(opPing, []byte("ka")); err != nil {
				c.shutdown()
				return
			}
		case <-c.done:
			_ = c.conn.WriteClose(1000, "")
			c.conn.Close()
			return
		}
	}
}

// readPump — читает кадры (пинги обрабатываются внутри ReadFrame), диспатчит JSON.
func (c *Client) readPump() {
	// idle-окно: соединение живо, пока кадры (в т.ч. pong на наши пинги) приходят
	c.conn.SetIdleWindow(idleTimeout)
	for {
		op, data, err := c.conn.ReadFrame()
		if err != nil {
			break
		}
		if op == opText {
			var f wsIn
			if json.Unmarshal(data, &f) == nil {
				c.hub.handleFrame(c, &f)
			} // битый JSON молча игнорируем
		}
	}
	c.hub.disconnect(c)
}

// shutdown — идемпотентное закрытие: close-кадр и TCP с небольшой задержкой.
func (c *Client) shutdown() {
	c.closeOnce.Do(func() {
		close(c.done)
		time.AfterFunc(150*time.Millisecond, func() { c.conn.Close() })
	})
}

// sendFrame — неблокирующая постановка кадра в очередь отправки.
func (c *Client) sendFrame(b []byte) {
	select {
	case c.send <- b:
	default: // переполнение очереди — кадр теряется, хаб не блокируется
	}
}

// dropActiveCallLocked — погасить активный (не в очереди) звонок юзера.
// Вызывается при замене/обрыве подключения; queued-записи переживают замену.
func (h *Hub) dropActiveCallLocked(uid int64) (int64, string, bool) {
	e := h.calls[uid]
	if e == nil || e.queued {
		return 0, "", false
	}
	h.clearCallLocked(uid, e.peer, e.callID)
	return e.peer, e.callID, true
}

// disconnect — юзер ушёл: presence off + lastSeen. Активный разговор (talk)
// переводится в грейс-период: медиа идёт P2P и не зависит от WS, а телефон мог
// просто свернуться (WebView заморозили). Если юзер не вернётся за callGrace —
// звонок завершается. Неотвеченный дозвон и очередь — как раньше, гасятся сразу.
func (h *Hub) disconnect(c *Client) {
	h.mu.Lock()
	if h.conns[c.uid] != c {
		// Подключение уже заменено новым — presence не трогаем.
		h.mu.Unlock()
		return
	}
	delete(h.conns, c.uid)

	var endPeer int64
	var endCallID string
	hadCall := false
	if e := h.calls[c.uid]; e != nil {
		if e.queued {
			if e.caller {
				// Вызывающий ушёл, пока звонок висел в очереди, — снимаем звонок.
				h.queue.removeByCaller(e.peer, c.uid, e.callID)
				h.clearCallLocked(c.uid, e.peer, e.callID)
			}
			// Адресат очереди: звонок остаётся ждать его следующего входа.
		} else if e.answered {
			// Разговор уже шёл: медиа идёт P2P и не зависит от WS (юзер свернул
			// приложение — WebView заморозили). Переводим звонок в грейс: если юзер
			// не вернётся, а собеседник оффлайн — звонок завершится по таймеру.
			// Если собеседник онлайн — он сам завершит звонок кнопкой.
			if !e.grace {
				e.grace = true
				callID := e.callID
				grace := h.callGrace
				h.grace[callID] = time.AfterFunc(grace, func() { h.callGraceExpired(callID) })
			}
		} else {
			h.clearCallLocked(c.uid, e.peer, e.callID)
			endPeer, endCallID, hadCall = e.peer, e.callID, true
		}
	}
	h.mu.Unlock()

	c.shutdown()
	h.store.SetPresence(c.uid, "off", "", time.Now().Unix()) // обновляет lastSeen
	if hadCall {
		h.sendTo(endPeer, outCall{Type: "call", Op: "end", From: c.uid, CallID: endCallID})
	}
	h.broadcastPresence(c.uid)
}

// callGraceExpired — грейс-период истёк. Если кто-то из участников вернулся —
// ничего не делаем (звонок продолжается). Если оба молчат — завершаем разговор.
func (h *Hub) callGraceExpired(callID string) {
	h.mu.Lock()
	delete(h.grace, callID)
	var parts []int64
	for uid, e := range h.calls {
		if e.callID == callID {
			parts = append(parts, uid)
		}
	}
	if len(parts) < 2 {
		h.mu.Unlock()
		return // звонка уже нет
	}
	// Кто-то онлайн (вернулся) — звонок жив, снимаю флаги grace и оставляю всё как есть.
	online := false
	for _, uid := range parts {
		if _, ok := h.conns[uid]; ok {
			online = true
		}
		h.calls[uid].grace = false
	}
	if online {
		h.mu.Unlock()
		return
	}
	a, b := parts[0], parts[1]
	dur := int64(0)
	if e := h.calls[a]; e != nil && !e.talkStart.IsZero() {
		dur = time.Since(e.talkStart).Milliseconds()
	}
	h.clearCallLocked(a, b, callID)
	h.mu.Unlock()

	log.Printf("hub: звонок %s завершён по таймауту грейс-периода", callID)
	h.sendTo(a, outCall{Type: "call", Op: "end", From: b, CallID: callID})
	h.sendTo(b, outCall{Type: "call", Op: "end", From: a, CallID: callID})
	if dur > 0 {
		h.logSys(a, b, sysEnd, "end", b, dur)
	}
}

// clearCallLocked — убрать участие обеих сторон звонка и остановить таймеры (под h.mu).
func (h *Hub) clearCallLocked(a, b int64, callID string) {
	delete(h.calls, a)
	delete(h.calls, b)
	if t := h.timers[callID]; t != nil {
		t.Stop()
		delete(h.timers, callID)
	}
	if t := h.grace[callID]; t != nil {
		t.Stop()
		delete(h.grace, callID)
	}
}

// --- разбор входящих кадров ---

// wsIn — универсальный парсер клиентских кадров (поля используются по type).
type wsIn struct {
	Type   string          `json:"type"`
	ID     string          `json:"id"` // клиентский id сообщения (для ack)
	To     int64           `json:"to"`
	Text   string          `json:"text"`
	On     bool            `json:"on"`
	Seq    int64           `json:"seq"`
	Status string          `json:"status"`
	Mood   string          `json:"mood"`
	Op     string          `json:"op"`
	CallID string          `json:"callID"`
	SDP    string          `json:"sdp"`
	Cand   json.RawMessage `json:"cand"`
	Note   string          `json:"note"`
	Renego bool            `json:"renego"` // true — повторный offer/answer внутри идущего звонка (добавление видео)
}

// handleFrame — маршрутизация по полю type.
func (h *Hub) handleFrame(c *Client, f *wsIn) {
	switch f.Type {
	case "msg":
		h.handleMsg(c, f)
	case "typing":
		if peer := h.store.SnapshotUser(f.To); peer != nil && peer.ID != c.uid {
			h.sendTo(peer.ID, outTyping{Type: "typing", From: c.uid, On: f.On})
		}
	case "read":
		h.handleRead(c, f)
	case "presence":
		h.handlePresence(c, f)
	case "call":
		h.handleCall(c, f)
	case "ping":
		// keepalive от клиента: обновляет read deadline в readPump, отвечаем pong
		h.sendTo(c.uid, outPong{Type: "pong", Time: time.Now().Unix()})
	}
}

// handleMsg — сообщение: валидация → история → ack отправителю → доставка получателю.
func (h *Hub) handleMsg(c *Client, f *wsIn) {
	if f.To == c.uid {
		return
	}
	peer := h.store.SnapshotUser(f.To)
	if peer == nil {
		return
	}
	if n := utf8.RuneCountInString(f.Text); n == 0 || n > maxTextLen {
		return
	}
	m := h.store.AppendMsg(c.uid, peer.ID, f.Text, false)
	c.sendFrame(mustJSON(outSent{Type: "sent", ID: f.ID, SID: m.ID, Time: m.Time, Seq: m.Seq}))
	if peer.Bot {
		h.botRespond(c.uid, peer.ID, f.Text)
		return
	}
	h.deliverMsgTo(peer.ID, m)
}

// handleRead — «прочитал до seq»: обновить счётчик, уведомить собеседника.
func (h *Hub) handleRead(c *Client, f *wsIn) {
	if f.Seq <= 0 || f.To == c.uid || h.store.UserByID(f.To) == nil {
		return
	}
	if h.store.SetRead(c.uid, f.To, f.Seq) {
		h.sendTo(f.To, outRead{Type: "read", By: c.uid, Seq: f.Seq})
	}
}

// handlePresence — смена статуса/настроения: сохранить и разослать (inv → off).
func (h *Hub) handlePresence(c *Client, f *wsIn) {
	switch f.Status {
	case "on", "idle", "dnd", "inv":
	default:
		return
	}
	if runes := []rune(f.Mood); len(runes) > maxMoodLen {
		f.Mood = string(runes[:maxMoodLen])
	}
	h.store.SetPresence(c.uid, f.Status, f.Mood, time.Now().Unix())
	h.broadcastPresence(c.uid)
}

// --- звонки ---

// handleCall — маршрутизация операций звонка.
func (h *Hub) handleCall(c *Client, f *wsIn) {
	if f.CallID == "" {
		return
	}
	switch f.Op {
	case "offer":
		h.callOffer(c, f)
	case "answer":
		h.callAnswer(c, f)
	case "ice":
		h.callRelay(c, f)
	case "end":
		h.callFinish(c, f, "end", sysEnd)
	case "reject":
		h.callFinish(c, f, "reject", "")
	case "cancel":
		h.callCancel(c, f)
	}
}

// callOffer — исходящий звонок: активный дозвон, busy или очередь оффлайн-адресату.
func (h *Hub) callOffer(c *Client, f *wsIn) {
	if f.To == c.uid {
		return
	}
	target := h.store.SnapshotUser(f.To)
	if target == nil {
		return
	}
	if target.Bot {
		// Боту звонить нельзя.
		h.sendTo(c.uid, outCall{Type: "call", Op: "busy", From: target.ID, CallID: f.CallID})
		h.logSys(c.uid, target.ID, sysBusy, "busy", target.ID, 0)
		return
	}

	h.mu.Lock()
	if f.Renego {
		// Повторный offer внутри идущего звонка (добавили видео) — просто релей,
		// это не новый звонок и не занятость.
		e := h.calls[c.uid]
		if e == nil || e.callID != f.CallID || e.peer != f.To {
			h.mu.Unlock()
			return
		}
		peer := e.peer
		h.mu.Unlock()
		h.sendTo(peer, outCall{Type: "call", Op: "offer", From: c.uid, CallID: f.CallID, SDP: f.SDP, Renego: true})
		return
	}
	if _, busy := h.calls[target.ID]; busy {
		// У абонента уже есть звонок (активный или в очереди) → busy.
		h.mu.Unlock()
		h.sendTo(c.uid, outCall{Type: "call", Op: "busy", From: target.ID, CallID: f.CallID})
		h.logSys(c.uid, target.ID, sysBusy, "busy", target.ID, 0)
		return
	}
	if _, selfBusy := h.calls[c.uid]; selfBusy {
		// Вызывающий сам уже в звонке (в т.ч. ждёт в очереди).
		h.mu.Unlock()
		h.sendTo(c.uid, outCall{Type: "call", Op: "busy", From: target.ID, CallID: f.CallID})
		return
	}
	if _, online := h.conns[target.ID]; online {
		// Адресат в сети: активный дозвон.
		h.calls[c.uid] = &callEntry{callID: f.CallID, peer: target.ID, caller: true}
		h.calls[target.ID] = &callEntry{callID: f.CallID, peer: c.uid}
		callID := f.CallID
		h.timers[callID] = time.AfterFunc(h.callTimeout, func() { h.callTimedOut(callID) })
		if cl := h.conns[target.ID]; cl != nil {
			cl.sendFrame(mustJSON(outCallOffer{
				Type: "call", Op: "offer", From: c.uid, CallID: f.CallID,
				SDP: f.SDP, Note: f.Note,
			}))
		}
		h.mu.Unlock()
		return
	}
	// Адресат оффлайн: offer в очередь (у него «занят» слот), вызывающему queued.
	h.calls[c.uid] = &callEntry{callID: f.CallID, peer: target.ID, caller: true, queued: true}
	h.calls[target.ID] = &callEntry{callID: f.CallID, peer: c.uid, queued: true}
	h.queue.push(target.ID, queuedCall{From: c.uid, CallID: f.CallID, SDP: f.SDP, Note: f.Note})
	h.mu.Unlock()
	h.sendTo(c.uid, outQueued{Type: "call", Op: "queued", CallID: f.CallID})
}

// callAnswer — ответ адресата: переслать answer вызывающему, снять таймер.
// answer с renego — повторный ответ внутри разговора (renegotiation), звонок не трогаем.
func (h *Hub) callAnswer(c *Client, f *wsIn) {
	h.mu.Lock()
	e := h.calls[c.uid]
	if e == nil || e.callID != f.CallID {
		h.mu.Unlock()
		return
	}
	if f.Renego || e.caller {
		peer := e.peer
		h.mu.Unlock()
		h.sendTo(peer, outCall{Type: "call", Op: "answer", From: c.uid, CallID: f.CallID, SDP: f.SDP, Renego: f.Renego})
		return
	}
	e.answered = true
	e.talkStart = time.Now()
	if pe := h.calls[e.peer]; pe != nil && pe.callID == f.CallID {
		pe.answered = true
		pe.talkStart = e.talkStart
	}
	callerUID := e.peer
	if t := h.timers[f.CallID]; t != nil {
		t.Stop()
		delete(h.timers, f.CallID)
	}
	h.mu.Unlock()
	h.sendTo(callerUID, outCall{Type: "call", Op: "answer", From: c.uid, CallID: f.CallID, SDP: f.SDP})
}

// callRelay — прозрачная пересылка ice участником звонка.
func (h *Hub) callRelay(c *Client, f *wsIn) {
	h.mu.Lock()
	e := h.calls[c.uid]
	if e == nil || e.callID != f.CallID {
		h.mu.Unlock()
		return
	}
	peer := e.peer
	h.mu.Unlock()
	h.sendTo(peer, outCall{Type: "call", Op: "ice", From: c.uid, CallID: f.CallID, Cand: f.Cand})
}

// callFinish — end/reject: переслать операцию второй стороне; end дополнительно
// пишет sys-сообщение с длительностью (фронт строит фразу сам).
func (h *Hub) callFinish(c *Client, f *wsIn, op string, _ string) {
	h.mu.Lock()
	e := h.calls[c.uid]
	if e == nil || e.callID != f.CallID || e.queued {
		h.mu.Unlock()
		return
	}
	peer := e.peer
	dur := int64(0)
	if !e.talkStart.IsZero() {
		dur = time.Since(e.talkStart).Milliseconds()
	}
	h.clearCallLocked(c.uid, peer, f.CallID)
	h.mu.Unlock()
	h.sendTo(peer, outCall{Type: "call", Op: op, From: c.uid, CallID: f.CallID})
	switch op {
	case "end":
		h.logSys(c.uid, peer, sysEnd, "end", peer, dur)
	case "reject":
		h.logSys(c.uid, peer, sysReject, "reject", peer, 0)
	}
}

// callCancel — отмена вызывающим: и для висящего в очереди, и для активного дозвона.
func (h *Hub) callCancel(c *Client, f *wsIn) {
	h.mu.Lock()
	e := h.calls[c.uid]
	if e == nil || e.callID != f.CallID || !e.caller {
		h.mu.Unlock()
		return // отменять может только вызывающий
	}
	peer := e.peer
	queued := e.queued
	h.clearCallLocked(c.uid, peer, f.CallID)
	if queued {
		h.queue.removeByCaller(peer, c.uid, f.CallID)
		h.mu.Unlock()
		// ack вызывающему (без sys-строки — фронт рисует её сам)
		h.sendTo(c.uid, outCall{Type: "call", Op: "cancel", From: c.uid, CallID: f.CallID})
		return
	}
	h.mu.Unlock()
	h.sendTo(peer, outCall{Type: "call", Op: "cancel", From: c.uid, CallID: f.CallID})
	h.logSys(c.uid, peer, sysCancel, "cancel", peer, 0)
}

// callTimedOut — 45с без ответа: sys «Пропущенный звонок» обеим сторонам, end, чистка.
func (h *Hub) callTimedOut(callID string) {
	h.mu.Lock()
	var callerUID, calleeUID int64
	for uid, e := range h.calls {
		if e.callID != callID {
			continue
		}
		if e.caller {
			callerUID = uid
		} else {
			calleeUID = uid
		}
	}
	if callerUID == 0 || calleeUID == 0 || h.calls[callerUID].answered {
		delete(h.timers, callID)
		h.mu.Unlock()
		return
	}
	h.clearCallLocked(callerUID, calleeUID, callID)
	h.mu.Unlock()

	log.Printf("hub: звонок %s пропущен (нет ответа)", callID)
	h.logSys(callerUID, calleeUID, sysMissed, "missed", calleeUID, 0)
	h.sendTo(callerUID, outCall{Type: "call", Op: "end", From: calleeUID, CallID: callID})
	h.sendTo(calleeUID, outCall{Type: "call", Op: "end", From: callerUID, CallID: callID})
}

// --- служебные сообщения и доставка ---

// logSys — записать sys-сообщение о звонке в переписку и доставить обеим сторонам онлайн.
// op — тип события (end/missed/cancel/reject/busy), peer — второй участник, durMS — длительность.
func (h *Hub) logSys(from, to int64, text, op string, peer, durMS int64) {
	m := h.store.AppendSys(from, to, text, op, peer, durMS)
	frame := mustJSON(outMsg{Type: "msg", From: m.From, ID: m.ID, Text: m.Text, Time: m.Time, Seq: m.Seq, Sys: m.Sys, Op: m.SysOp, Peer: m.Peer, DurationMS: m.DurMS})
	h.mu.Lock()
	for _, uid := range []int64{from, to} {
		if c := h.conns[uid]; c != nil {
			c.sendFrame(frame)
		}
	}
	h.mu.Unlock()
}

// sendTo — доставить кадр юзеру, если он онлайн.
func (h *Hub) sendTo(uid int64, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if c := h.conns[uid]; c != nil {
		c.sendFrame(b)
	}
}

// deliverMsgTo — доставка сообщения юзеру (используется и ботом).
func (h *Hub) deliverMsgTo(uid int64, m Msg) {
	h.sendTo(uid, outMsg{Type: "msg", From: m.From, ID: m.ID, Text: m.Text, Time: m.Time, Seq: m.Seq, Sys: m.Sys})
}

// mustJSON — маршал исходящего кадра.
func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		log.Printf("hub: ошибка маршала кадра: %v", err)
		return []byte("{}")
	}
	return b
}

// --- исходящие кадры (структуры строго по протоколу) ---

type outHello struct {
	Type   string         `json:"type"`
	Me     outUserMe      `json:"me"`
	Users  []outUser      `json:"users"`
	Unread map[string]int `json:"unread"`
}

type outUserMe struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	Avatar int    `json:"avatar"`
	Status string `json:"status"`
	Mood   string `json:"mood"`
}

type outUser struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Avatar   int    `json:"avatar"`
	Status   string `json:"status"`
	Mood     string `json:"mood"`
	LastSeen int64  `json:"lastSeen"`
	Bot      bool   `json:"bot"`
}

type outPresence struct {
	Type     string `json:"type"`
	ID       int64  `json:"id"`
	Status   string `json:"status"`
	Mood     string `json:"mood"`
	LastSeen int64  `json:"lastSeen"`
}

type outMsg struct {
	Type string `json:"type"`
	From int64  `json:"from"`
	ID   string `json:"id"`
	Text string `json:"text"`
	Time int64  `json:"time"`
	Seq  int64  `json:"seq"`
	Sys  bool   `json:"sys"`
	// Для sys-строк о звонках: op события, кто второй участник и сколько длился разговор.
	Op         string `json:"sysop,omitempty"`
	Peer       int64  `json:"peer,omitempty"`
	DurationMS int64  `json:"dur,omitempty"`
}

type outSent struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	SID  string `json:"sid"`
	Time int64  `json:"time"`
	Seq  int64  `json:"seq"`
}

type outTyping struct {
	Type string `json:"type"`
	From int64  `json:"from"`
	On   bool   `json:"on"`
}

type outPong struct {
	Type string `json:"type"`
	Time int64  `json:"time"`
}

type outRead struct {
	Type string `json:"type"`
	By   int64  `json:"by"`
	Seq  int64  `json:"seq"`
}

// outCall — универсальный звонковый кадр (note есть только у offer).
type outCall struct {
	Type   string          `json:"type"`
	Op     string          `json:"op"`
	From   int64           `json:"from"`
	CallID string          `json:"callID"`
	SDP    string          `json:"sdp,omitempty"`
	Cand   json.RawMessage `json:"cand,omitempty"`
	Renego bool            `json:"renego,omitempty"` // повторный offer/answer (видео в идущем звонке)
}

// outCallOffer — offer с обязательным полем note.
type outCallOffer struct {
	Type   string `json:"type"`
	Op     string `json:"op"`
	From   int64  `json:"from"`
	CallID string `json:"callID"`
	SDP    string `json:"sdp"`
	Note   string `json:"note"`
}

// outQueued — ответ вызывающему при оффлайн-адресате (без from).
type outQueued struct {
	Type   string `json:"type"`
	Op     string `json:"op"`
	CallID string `json:"callID"`
}

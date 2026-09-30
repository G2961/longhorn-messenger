package main

// Минимальная реализация WebSocket (RFC 6455) на чистой stdlib:
// серверный handshake, клиентский handshake (для тестов), текстовые кадры,
// ping/pong/close, фрагментация данных, маска обязательна для клиентских кадров.

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Опкоды кадров RFC 6455.
const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA
)

// wsGUID — магическая строка из RFC 6455 для вычисления Sec-WebSocket-Accept.
const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// maxFrameSize — максимальный размер payload одного кадра (SDP влезает с запасом).
const maxFrameSize = 1 << 20

var errWSProtocol = errors.New("websocket: нарушение протокола")

// WSConn — WebSocket-соединение поверх net.Conn.
// server=true — роль сервера: исходящие кадры без маски, входящие обязаны быть маскированными.
type WSConn struct {
	conn net.Conn
	br   *bufio.Reader

	wmu    sync.Mutex // сериализует запись кадров
	server bool

	// idle-окно: если задано, ReadFrame продлевает read deadline после
	// каждого прочитанного кадра (в т.ч. контрольного pong внутри цикла).
	idle     time.Duration
	idleOnce sync.Once

	closeOnce sync.Once
	closeErr  error
}

// wsAccept — серверный handshake: проверяет заголовки апгрейда, отдает 101 и hijack-ает соединение.
func wsAccept(w http.ResponseWriter, r *http.Request) (*WSConn, error) {
	if !hasToken(r.Header.Get("Upgrade"), "websocket") || !hasToken(r.Header.Get("Connection"), "upgrade") {
		http.Error(w, "expected websocket upgrade", http.StatusBadRequest)
		return nil, errors.New("websocket: не websocket-запрос")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "missing Sec-WebSocket-Key", http.StatusBadRequest)
		return nil, errors.New("websocket: нет Sec-WebSocket-Key")
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return nil, errors.New("websocket: hijack не поддержан")
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}
	// Ответ пишем вручную: ResponseWriter после hijack недоступен.
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + wsAcceptKey(key) + "\r\n" +
		"Access-Control-Allow-Origin: *\r\n" +
		"\r\n"
	conn.SetDeadline(time.Time{}) // httptest может ставить дедлайны
	if _, err := conn.Write([]byte(resp)); err != nil {
		conn.Close()
		return nil, err
	}
	return &WSConn{conn: conn, br: brw.Reader, server: true}, nil
}

// wsDial — клиентский handshake (используется тестами): GET с ключом, проверка accept.
func wsDial(rawURL string) (*WSConn, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	host := u.Host
	if u.Port() == "" {
		host = net.JoinHostPort(u.Hostname(), "80")
	}
	conn, err := net.DialTimeout("tcp", host, 10*time.Second)
	if err != nil {
		return nil, err
	}
	keyRaw := make([]byte, 16)
	if _, err := rand.Read(keyRaw); err != nil {
		conn.Close()
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyRaw)
	path := u.RequestURI()
	if path == "" {
		path = "/"
	}
	req := "GET " + path + " HTTP/1.1\r\n" +
		"Host: " + u.Host + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n" +
		"\r\n"
	conn.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := conn.Write([]byte(req)); err != nil {
		conn.Close()
		return nil, err
	}
	br := bufio.NewReader(conn)
	httpReq, _ := http.NewRequest(http.MethodGet, rawURL, nil)
	resp, err := http.ReadResponse(br, httpReq)
	if err != nil {
		conn.Close()
		return nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		conn.Close()
		return nil, fmt.Errorf("websocket: неожиданный статус %d", resp.StatusCode)
	}
	if resp.Header.Get("Sec-WebSocket-Accept") != wsAcceptKey(key) {
		conn.Close()
		return nil, errors.New("websocket: неверный Sec-WebSocket-Accept")
	}
	conn.SetDeadline(time.Time{})
	return &WSConn{conn: conn, br: br, server: false}, nil
}

// wsAcceptKey — base64(sha1(key + GUID)).
func wsAcceptKey(key string) string {
	sum := sha1.Sum([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// hasToken — проверяет значение спискового заголовка (Upgrade/Connection).
func hasToken(header, token string) bool {
	for _, part := range strings.Split(header, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

// ReadFrame читает один кадр. Контрольные кадры обрабатываются на месте:
// ping автоматически отвечает pong, close эхается и возвращается наружу.
// Фрагментированные данные склеиваются. Возвращает опкод данных (opText/opBinary)
// или opClose и payload.
func (c *WSConn) ReadFrame() (int, []byte, error) {
	fragOpcode := -1
	var fragBuf []byte
	for {
		// каждое прочитанное «сообщение» (в т.ч. контрольное pong внутри цикла)
		// продлевает read deadline — иначе ping/pong не спасают от idle-таймаута
		if c.idle > 0 {
			_ = c.SetReadDeadline(time.Now().Add(c.idle))
		}
		var hdr [2]byte
		if _, err := io.ReadFull(c.br, hdr[:]); err != nil {
			return 0, nil, err
		}
		final := hdr[0]&0x80 != 0
		op := int(hdr[0] & 0x0F)
		masked := hdr[1]&0x80 != 0
		length := int64(hdr[1] & 0x7F)
		switch length {
		case 126:
			var ext [2]byte
			if _, err := io.ReadFull(c.br, ext[:]); err != nil {
				return 0, nil, err
			}
			length = int64(binary.BigEndian.Uint16(ext[:]))
		case 127:
			var ext [8]byte
			if _, err := io.ReadFull(c.br, ext[:]); err != nil {
				return 0, nil, err
			}
			u := binary.BigEndian.Uint64(ext[:])
			if u > maxFrameSize {
				return 0, nil, errors.New("websocket: кадр слишком большой")
			}
			length = int64(u)
		}
		// Клиентские кадры обязаны быть маскированными, серверные — нет.
		if c.server != masked {
			return 0, nil, errWSProtocol
		}
		var mask [4]byte
		if masked {
			if _, err := io.ReadFull(c.br, mask[:]); err != nil {
				return 0, nil, err
			}
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(c.br, payload); err != nil {
			return 0, nil, err
		}
		if masked {
			for i := range payload {
				payload[i] ^= mask[i&3]
			}
		}

		// Контрольные кадры: не фрагментируются, payload ≤ 125.
		if op >= opClose {
			if !final || length > 125 {
				return 0, nil, errWSProtocol
			}
			switch op {
			case opPing:
				_ = c.WriteFrame(opPong, payload)
				continue // контрольный кадр может прийти между фрагментами
			case opPong:
				continue
			case opClose:
				code := 1005
				if len(payload) >= 2 {
					code = int(binary.BigEndian.Uint16(payload[:2]))
				}
				_ = c.WriteFrame(opClose, closePayload(code, "")) // эхо close
				return opClose, payload, nil
			default:
				return 0, nil, errWSProtocol
			}
		}

		// Кадры данных.
		if op == opContinuation {
			if fragOpcode < 0 {
				return 0, nil, errWSProtocol
			}
			fragBuf = append(fragBuf, payload...)
			if final {
				return fragOpcode, fragBuf, nil
			}
			continue
		}
		if fragOpcode >= 0 {
			return 0, nil, errWSProtocol // новый кадр до завершения предыдущего
		}
		if final {
			return op, payload, nil
		}
		fragOpcode, fragBuf = op, append([]byte(nil), payload...)
	}
}

// WriteFrame пишет кадр: сервер — без маски, клиент — со случайной маской.
func (c *WSConn) WriteFrame(op int, payload []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	var hdr [14]byte
	hdr[0] = 0x80 | byte(op) // FIN=1
	lenBit := byte(0)
	var maskKey [4]byte
	if !c.server {
		if _, err := rand.Read(maskKey[:]); err != nil {
			return err
		}
		lenBit = 0x80
	}
	n := 0
	plen := int64(len(payload))
	switch {
	case plen <= 125:
		hdr[1] = lenBit | byte(plen)
		n = 2
	case plen <= 0xFFFF:
		hdr[1] = lenBit | 126
		binary.BigEndian.PutUint16(hdr[2:4], uint16(plen))
		n = 4
	default:
		hdr[1] = lenBit | 127
		binary.BigEndian.PutUint64(hdr[2:10], uint64(plen))
		n = 10
	}
	if !c.server {
		copy(hdr[n:], maskKey[:])
		n += 4
	}
	buf := make([]byte, 0, n+len(payload))
	buf = append(buf, hdr[:n]...)
	if !c.server {
		for i, b := range payload {
			buf = append(buf, b^maskKey[i&3])
		}
	} else {
		buf = append(buf, payload...)
	}
	c.conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
	_, err := c.conn.Write(buf)
	return err
}

// WriteText отправляет текстовый кадр.
func (c *WSConn) WriteText(b []byte) error { return c.WriteFrame(opText, b) }

// WriteClose отправляет close-кадр с кодом и причиной.
func (c *WSConn) WriteClose(code int, reason string) error {
	return c.WriteFrame(opClose, closePayload(code, reason))
}

func closePayload(code int, reason string) []byte {
	p := make([]byte, 2, 2+len(reason))
	binary.BigEndian.PutUint16(p, uint16(code))
	if len(reason) > 123 {
		reason = reason[:123]
	}
	return append(p, []byte(reason)...)
}

// SetReadDeadline — дедлайн на чтение (idle-таймаут).
func (c *WSConn) SetReadDeadline(t time.Time) error { return c.conn.SetReadDeadline(t) }

// SetIdleWindow — включить автопродление read deadline после каждого кадра.
func (c *WSConn) SetIdleWindow(d time.Duration) {
	c.idle = d
	_ = c.SetReadDeadline(time.Now().Add(d))
}

// Close закрывает TCP-соединение (идемпотентно).
func (c *WSConn) Close() error {
	c.closeOnce.Do(func() { c.closeErr = c.conn.Close() })
	return c.closeErr
}

package main

// Эхо-бот: на любое сообщение отвечает typing on → пауза ~1с → эхо → typing off.
// Статус всегда on, звонки боту → busy (см. hub.callOffer).

import (
	"log"
	"time"
)

// botRespond — асинхронная реакция бота на сообщение от fromUID.
func (h *Hub) botRespond(fromUID, botID int64, origText string) {
	go func() {
		defer func() {
			if rv := recover(); rv != nil {
				log.Printf("bot: паника подавлена: %v", rv)
			}
		}()
		time.Sleep(100 * time.Millisecond)

		// Собеседник видит, что бот печатает.
		h.sendTo(fromUID, outTyping{Type: "typing", From: botID, On: true})
		time.Sleep(botReplyDelay)

		// Эхо: текст отправителя возвращается ему с префиксом.
		m := h.store.AppendMsg(botID, fromUID, "Эхо: "+origText, false)
		h.deliverMsgTo(fromUID, m)

		h.sendTo(fromUID, outTyping{Type: "typing", From: botID, On: false})
	}()
}

// ensureBotOnline — статус бота в базе всегда on.
func ensureBotOnline(store *Store) {
	for _, u := range store.UsersAll() {
		if u.Bot && u.Status != "on" {
			store.SetPresence(u.ID, "on", "", time.Now().Unix())
		}
	}
}

// main.go — точка входа: флаги, сид демо-юзеров, HTTP-сервер, плавное завершение.
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	addr := flag.String("addr", ":8080", "адрес прослушивания")
	dbPath := flag.String("db", "data/db.json", "путь к JSON-базе")
	seed := flag.Bool("seed", false, "создать демо-юзеров при пустой базе")
	flag.Parse()

	store, err := newStore(*dbPath)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer store.close()

	// Сид демо-юзеров только при пустой базе.
	if *seed && len(store.UsersAll()) == 0 {
		seedDemoUsers(store)
	}
	ensureBotOnline(store)

	hub := newHub(store)
	api := &apiServer{store: store, hub: hub}
	mux := http.NewServeMux()
	api.registerRoutes(mux)

	srv := &http.Server{Addr: *addr, Handler: mux}
	go func() {
		log.Printf("longhorn-server: слушаю %s (база: %s)", *addr, *dbPath)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http: %v", err)
		}
	}()

	// Плавное завершение: сохранить базу по Ctrl+C / SIGTERM.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Println("longhorn-server: завершаюсь...")
	_ = srv.Close()
	time.Sleep(100 * time.Millisecond) // дать флашу дебаунса шанс
}

// seedDemoUsers — демо-юзеры и эхо-бот (пароль у всех demo1234).
func seedDemoUsers(store *Store) {
	demo := []struct {
		name   string
		avatar int
		status string
		mood   string
	}{
		{"Алиса", 0, "on", "Люблю длинные разговоры"},
		{"Дима Билд", 1, "idle", "Собираю билд"},
		{"Хук-хук", 2, "dnd", "Не беспокоить, пишу код"},
		{"Сергей", 3, "off", ""},
		{"Катя", 4, "on", "Читаю книжку"},
	}
	for _, d := range demo {
		u, _, err := store.CreateUser(d.name, "demo1234", d.avatar, false)
		if err != nil {
			log.Printf("seed: не удалось создать %s: %v", d.name, err)
			continue
		}
		store.SetPresence(u.ID, d.status, d.mood, time.Now().Unix())
	}
	// Эхо-бот: avatar 5, статус всегда on.
	if _, _, err := store.CreateUser("Эхо-бот", "demo1234", 5, true); err != nil {
		log.Printf("seed: не удалось создать бота: %v", err)
	}
	store.flush()
	log.Println("seed: демо-юзеры созданы (пароль demo1234)")
}

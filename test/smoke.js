/* Быстрый smoke: сервер + e2e в одном процессе (фоновые процессы умирают между вызовами шелла). */
const { spawn } = require("child_process");
const srv = spawn("C:/Temp/lh-server-test.exe", ["-addr", ":8099", "-db", "C:/Temp/lh-test-db.json", "-seed"], { stdio: "ignore" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch("http://127.0.0.1:8099/health");
      if (r.ok) break;
    } catch (e) {}
    await wait(300);
  }
  const e2e = spawn("node", ["test/e2e.js"], { env: { ...process.env, BASE: "http://127.0.0.1:8099" }, stdio: "inherit" });
  e2e.on("exit", (code) => { srv.kill(); process.exit(code); });
})();

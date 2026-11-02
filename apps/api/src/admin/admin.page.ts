export const ADMIN_DASHBOARD_HTML = `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>TALK · ניטור</title>
  <style>
    :root {
      --bg: #0c0e12;
      --card: #151922;
      --line: #252b36;
      --text: #e8edf5;
      --muted: #8b95a8;
      --accent: #f5c518;
      --green: #3dd68c;
      --red: #ff5d6c;
      --blue: #5b8cff;
      --warn: #ffb020;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); font: 14px/1.45 "Segoe UI", system-ui, sans-serif; }
    header {
      display: flex; align-items: center; justify-content: space-between; gap: 16px;
      padding: 18px 22px; border-bottom: 1px solid var(--line); position: sticky; top: 0;
      background: rgba(12,14,18,.92); backdrop-filter: blur(10px); z-index: 2;
    }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; letter-spacing: .04em; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--red); box-shadow: 0 0 0 4px rgba(255,93,108,.12); }
    .dot.ok { background: var(--green); box-shadow: 0 0 0 4px rgba(61,214,140,.12); }
    .meta { color: var(--muted); display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }
    button, .btn {
      background: transparent; color: var(--text); border: 1px solid var(--line);
      border-radius: 10px; padding: 8px 12px; cursor: pointer; font: inherit;
    }
    button:hover { border-color: var(--accent); }
    main { padding: 22px; display: grid; gap: 18px; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 16px; }
    .kpi .label { color: var(--muted); font-size: 12px; }
    .kpi .value { font-size: 28px; font-weight: 800; margin-top: 4px; }
    h2 { margin: 0 0 12px; font-size: 13px; color: var(--muted); font-weight: 700; letter-spacing: .06em; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: start; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); font-size: 11px; font-weight: 700; }
    .grid { display: grid; grid-template-columns: 1.1fr 1fr; gap: 18px; }
    @media (max-width: 960px) { .grid { grid-template-columns: 1fr; } }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
    .walkie { background: rgba(245,197,24,.15); color: var(--accent); }
    .text { background: rgba(91,140,255,.15); color: var(--blue); }
    .voice, .image, .video { background: rgba(61,214,140,.12); color: var(--green); }
    .call { background: rgba(255,93,108,.12); color: var(--red); }
    .empty { color: var(--muted); padding: 18px 6px; }
    #gate {
      position: fixed; inset: 0; background: rgba(8,10,14,.92); display: grid; place-items: center; z-index: 9;
    }
    #gate.hidden { display: none; }
    form { width: min(380px, 92vw); background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 22px; }
    input {
      width: 100%; margin: 12px 0 16px; padding: 12px; border-radius: 10px; border: 1px solid var(--line);
      background: #0c0e12; color: var(--text); font: inherit;
    }
    .err { color: var(--red); min-height: 1.2em; font-size: 13px; }
    .open { color: var(--green); }
    .away { color: var(--muted); }
  </style>
</head>
<body>
  <div id="gate">
    <form id="login">
      <div class="brand"><span class="dot"></span> TALK ניטור</div>
      <p class="meta">הזינו את טוקן הניהול. רק מי שיש לו את הטוקן רואה את הדשבורד.</p>
      <input id="token" type="password" autocomplete="current-password" placeholder="ADMIN_DASHBOARD_TOKEN" required>
      <button type="submit">כניסה</button>
      <p class="err" id="login-err"></p>
    </form>
  </div>
  <header>
    <div class="brand"><span id="live-dot" class="dot"></span> TALK · ניטור פנימי</div>
    <div class="meta">
      <span id="updated">ממתין…</span>
      <span id="uptime"></span>
      <button type="button" id="logout">יציאה</button>
    </div>
  </header>
  <main>
    <section class="kpis">
      <div class="card kpi"><div class="label">סוקטים פעילים</div><div class="value" id="k-sockets">—</div></div>
      <div class="card kpi"><div class="label">משתמשים מחוברים</div><div class="value" id="k-users">—</div></div>
      <div class="card kpi"><div class="label">חדרים פעילים</div><div class="value" id="k-rooms">—</div></div>
      <div class="card kpi"><div class="label">שיחות חיות</div><div class="value" id="k-calls">—</div></div>
      <div class="card kpi"><div class="label">אירועים בשעה</div><div class="value" id="k-hour">—</div></div>
      <div class="card kpi"><div class="label">משתמשים במערכת</div><div class="value" id="k-total">—</div></div>
    </section>
    <section class="grid">
      <div class="card">
        <h2>חדרים ושיחות פעילות</h2>
        <div id="rooms"><div class="empty">אין חדרים פעילים</div></div>
      </div>
      <div class="card">
        <h2>מחוברים עכשיו</h2>
        <div id="people"><div class="empty">אין סוקטים מחוברים</div></div>
      </div>
    </section>
    <section class="card">
      <h2>אירועים אחרונים</h2>
      <div id="events"><div class="empty">אין אירועים עדיין</div></div>
    </section>
  </main>
  <script>
    const gate = document.getElementById("gate");
    const loginErr = document.getElementById("login-err");
    const liveDot = document.getElementById("live-dot");
    let timer = 0;

    function kindClass(kind) {
      if (kind === "walkie") return "walkie";
      if (kind === "text") return "text";
      if (kind === "call") return "call";
      return "voice";
    }

    function kindLabel(kind) {
      if (kind === "walkie") return "ווקי";
      if (kind === "text") return "הודעה";
      if (kind === "voice") return "הודעה קולית";
      if (kind === "image") return "תמונה";
      if (kind === "video") return "וידאו";
      return kind || "אירוע";
    }

    function fmtUptime(sec) {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return "אפטיים " + h + "ש " + m + "ד";
    }

    function fmtWhen(iso) {
      const d = new Date(iso);
      return d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }

    function esc(value) {
      return String(value || "").replace(/[&<>"']/g, function (ch) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
      });
    }

    function render(data) {
      liveDot.classList.add("ok");
      document.getElementById("k-sockets").textContent = data.sockets;
      document.getElementById("k-users").textContent = data.usersOnline;
      document.getElementById("k-rooms").textContent = data.roomsActive;
      document.getElementById("k-calls").textContent = data.callsLive;
      document.getElementById("k-hour").textContent = data.eventsLastHour;
      document.getElementById("k-total").textContent = data.usersTotal;
      document.getElementById("updated").textContent = "עודכן " + new Date(data.at).toLocaleTimeString("he-IL");
      document.getElementById("uptime").textContent = fmtUptime(data.uptimeSec);

      const roomRows = (data.calls || []).map(function (call) {
        return "<tr><td><span class='badge call'>" + (call.video ? "וידאו" : "שיחה") + "</span></td><td>" +
          esc(call.groupName || call.callerName) + "</td><td>" + call.joined + "/" + call.party +
          "</td><td>" + (call.accepted ? "פעילה" : "מצלצלת") + "</td></tr>";
      }).concat((data.rooms || []).slice(0, 30).map(function (room) {
        return "<tr><td><span class='badge text'>" + esc(room.type) + "</span></td><td>" +
          esc(room.name) + "</td><td>" + room.connected + " מחוברים</td><td>" + room.members + " חברים</td></tr>";
      }));
      document.getElementById("rooms").innerHTML = roomRows.length
        ? "<table><thead><tr><th>סוג</th><th>שם</th><th>מחוברים</th><th>מצב</th></tr></thead><tbody>" +
          roomRows.join("") + "</tbody></table>"
        : "<div class='empty'>אין חדרים פעילים</div>";

      const people = data.connected || [];
      document.getElementById("people").innerHTML = people.length
        ? "<table><thead><tr><th>שם</th><th>טלפון</th><th>שפה</th><th>סוקטים</th><th>אפליקציה</th></tr></thead><tbody>" +
          people.map(function (user) {
            return "<tr><td>" + esc(user.name) + "</td><td>" + esc(user.phone) + "</td><td>" +
              esc(user.speakLang) + " → " + esc(user.listenLang) + "</td><td>" + user.sockets +
              "</td><td class='" + (user.appOpen ? "open" : "away") + "'>" +
              (user.appOpen ? "פתוחה" : "ברקע") + "</td></tr>";
          }).join("") + "</tbody></table>"
        : "<div class='empty'>אין סוקטים מחוברים</div>";

      const events = data.events || [];
      document.getElementById("events").innerHTML = events.length
        ? "<table><thead><tr><th>זמן</th><th>סוג</th><th>שולח</th><th>יעד</th><th>תוכן</th></tr></thead><tbody>" +
          events.map(function (row) {
            return "<tr><td>" + fmtWhen(row.at) + "</td><td><span class='badge " + kindClass(row.kind) + "'>" +
              kindLabel(row.kind) + "</span></td><td>" + esc(row.sender) + "</td><td>" +
              esc(row.channel) + " · " + row.targets + "</td><td>" + esc(row.text || row.status) + "</td></tr>";
          }).join("") + "</tbody></table>"
        : "<div class='empty'>אין אירועים עדיין</div>";
    }

    async function pull() {
      try {
        const res = await fetch("/admin/api/snapshot", { credentials: "same-origin" });
        if (res.status === 401) {
          gate.classList.remove("hidden");
          liveDot.classList.remove("ok");
          return;
        }
        if (res.status === 503) {
          loginErr.textContent = "חסר ADMIN_DASHBOARD_TOKEN בשרת.";
          gate.classList.remove("hidden");
          return;
        }
        if (!res.ok) throw new Error("snapshot " + res.status);
        gate.classList.add("hidden");
        render(await res.json());
      } catch (err) {
        liveDot.classList.remove("ok");
        document.getElementById("updated").textContent = "אין חיבור לשרת";
      }
    }

    document.getElementById("login").addEventListener("submit", async function (ev) {
      ev.preventDefault();
      loginErr.textContent = "";
      const token = document.getElementById("token").value.trim();
      const res = await fetch("/admin/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token })
      });
      if (!res.ok) {
        loginErr.textContent = res.status === 503 ? "הטוקן לא הוגדר בשרת." : "טוקן שגוי.";
        return;
      }
      document.getElementById("token").value = "";
      await pull();
    });

    document.getElementById("logout").addEventListener("click", async function () {
      await fetch("/admin/logout", { method: "POST", credentials: "same-origin" });
      gate.classList.remove("hidden");
    });

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        clearInterval(timer);
        timer = 0;
        return;
      }
      pull();
      if (!timer) timer = setInterval(pull, 2500);
    });

    pull();
    timer = setInterval(pull, 2500);
  </script>
</body>
</html>
`;

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
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 16px; }
    .kpi .label { color: var(--muted); font-size: 12px; }
    .kpi .value { font-size: 28px; font-weight: 800; margin-top: 4px; }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
    .head h2 { margin: 0; font-size: 13px; color: var(--muted); font-weight: 700; letter-spacing: .06em; }
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
    .scroll { max-height: 280px; overflow: auto; border: 1px solid var(--line); border-radius: 12px; }
    .scroll.open { max-height: 70vh; }
    tr.clickable { cursor: pointer; }
    tr.clickable:hover { background: rgba(255,255,255,.04); }
    .clip { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .note { white-space: pre-wrap; word-break: break-word; }
    #gate {
      position: fixed; inset: 0; background: rgba(8,10,14,.92); display: grid; place-items: center; z-index: 9;
    }
    #gate.hidden, #sheet.hidden { display: none; }
    form { width: min(380px, 92vw); background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 22px; }
    input {
      width: 100%; margin: 12px 0 16px; padding: 12px; border-radius: 10px; border: 1px solid var(--line);
      background: #0c0e12; color: var(--text); font: inherit;
    }
    .err { color: var(--red); min-height: 1.2em; font-size: 13px; }
    .open { color: var(--green); }
    .away { color: var(--muted); }
    #sheet { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: grid; place-items: center; z-index: 8; padding: 16px; }
    .sheet-card { width: min(720px, 96vw); max-height: 80vh; overflow: auto; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 18px; }
    .kv { display: grid; grid-template-columns: 110px 1fr; gap: 8px 12px; }
    .kv b { color: var(--muted); font-weight: 700; }
    .event-list { max-height: 52vh; overflow: auto; border: 1px solid var(--line); border-radius: 12px; margin-top: 12px; }
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
  <div id="sheet" class="hidden">
    <div class="sheet-card">
      <div class="head"><h2 id="sheet-title">פירוט</h2><button type="button" id="sheet-close">סגור</button></div>
      <div id="sheet-body"></div>
    </div>
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
      <div class="card kpi"><div class="label">הורדות היום</div><div class="value" id="k-down">—</div></div>
      <div class="card kpi"><div class="label">כתבו לנו</div><div class="value" id="k-inbox">—</div></div>
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
    <section class="grid">
      <div class="card">
        <div class="head"><h2>הורדות</h2><span class="meta" id="down-meta"></span></div>
        <div id="downloads" class="scroll"><div class="empty">אין הורדות עדיין</div></div>
      </div>
      <div class="card">
        <div class="head"><h2>כתבו לנו</h2><span class="meta" id="inbox-meta"></span></div>
        <div id="inbox" class="scroll"><div class="empty">עדיין לא נשלחו הודעות</div></div>
      </div>
    </section>
    <section class="card">
      <div class="head">
        <h2>אירועים אחרונים · משתמשים</h2>
        <button type="button" id="events-all">הצג הכל</button>
      </div>
      <div id="events" class="scroll"><div class="empty">אין אירועים עדיין</div></div>
    </section>
  </main>
  <script>
    const gate = document.getElementById("gate");
    const loginErr = document.getElementById("login-err");
    const liveDot = document.getElementById("live-dot");
    const sheet = document.getElementById("sheet");
    const eventsBox = document.getElementById("events");
    let timer = 0;
    let lastData = null;
    let eventsOpen = false;
    let eventsScroll = 0;

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

    function fmtDate(iso) {
      return new Date(iso).toLocaleString("he-IL");
    }

    function esc(value) {
      return String(value || "").replace(/[&<>"']/g, function (ch) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
      });
    }

    function kv(label, value) {
      return "<b>" + esc(label) + "</b><div class='note'>" + (value || "—") + "</div>";
    }

    function showSheet(title, html) {
      document.getElementById("sheet-title").textContent = title;
      document.getElementById("sheet-body").innerHTML = html;
      sheet.classList.remove("hidden");
    }

    function render(data) {
      lastData = data;
      liveDot.classList.add("ok");
      document.getElementById("k-sockets").textContent = data.sockets;
      document.getElementById("k-users").textContent = data.usersOnline;
      document.getElementById("k-rooms").textContent = data.roomsActive;
      document.getElementById("k-calls").textContent = data.callsLive;
      document.getElementById("k-down").textContent = data.downloadsToday;
      document.getElementById("k-inbox").textContent = data.inboxCount;
      document.getElementById("updated").textContent = "עודכן " + new Date(data.at).toLocaleTimeString("he-IL");
      document.getElementById("uptime").textContent = fmtUptime(data.uptimeSec);
      document.getElementById("down-meta").textContent = "השבוע " + (data.downloadsWeek || 0) + " · סה״כ " + (data.usersTotal || 0);
      document.getElementById("inbox-meta").textContent = (data.inboxCount || 0) + " הודעות";
      eventsBox.classList.toggle("open", eventsOpen);
      document.getElementById("events-all").textContent = eventsOpen ? "הקטן" : "הצג הכל";

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

      const downloads = data.downloads || [];
      document.getElementById("downloads").innerHTML = downloads.length
        ? "<table><thead><tr><th>מתי</th><th>שם</th><th>טלפון</th></tr></thead><tbody>" +
          downloads.map(function (row) {
            return "<tr><td>" + fmtDate(row.at) + "</td><td>" + esc(row.name) + "</td><td>" + esc(row.phone) + "</td></tr>";
          }).join("") + "</tbody></table>"
        : "<div class='empty'>אין הורדות עדיין</div>";

      const inbox = data.inbox || [];
      document.getElementById("inbox").innerHTML = inbox.length
        ? "<table><thead><tr><th>מתי</th><th>שם</th><th>טלפון</th><th>הודעה</th></tr></thead><tbody>" +
          inbox.map(function (row) {
            return "<tr class='clickable' data-inbox='" + esc(row.id) + "'><td>" + fmtDate(row.at) + "</td><td>" +
              esc(row.name) + "</td><td>" + esc(row.phone) + "</td><td class='clip'>" + esc(row.text) + "</td></tr>";
          }).join("") + "</tbody></table>"
        : "<div class='empty'>עדיין לא נשלחו הודעות מכתבו לנו</div>";

      const eventPeople = data.people || [];
      eventsBox.innerHTML = eventPeople.length
        ? "<table><thead><tr><th>שם</th><th>טלפון</th><th>אירועים</th><th>פעילות אחרונה</th></tr></thead><tbody>" +
          eventPeople.map(function (row) {
            return "<tr class='clickable' data-user='" + esc(row.id) + "'><td>" + esc(row.name) +
              "</td><td>" + esc(row.phone) + "</td><td>" + row.count + "</td><td>" +
              (row.lastAt ? fmtDate(row.lastAt) : "—") + "</td></tr>";
          }).join("") + "</tbody></table>"
        : "<div class='empty'>אין אירועים עדיין</div>";
      eventsBox.scrollTop = eventsScroll;
    }

    eventsBox.addEventListener("scroll", function () {
      eventsScroll = eventsBox.scrollTop;
    });

    document.getElementById("events-all").addEventListener("click", function () {
      eventsOpen = !eventsOpen;
      if (lastData) render(lastData);
    });

    eventsBox.addEventListener("click", async function (ev) {
      const row = ev.target.closest("[data-user]");
      if (!row) return;
      const userId = row.getAttribute("data-user");
      showSheet("אירועים", "<div class='empty'>טוען…</div>");
      try {
        const res = await fetch("/admin/api/people/" + encodeURIComponent(userId) + "/events", { credentials: "same-origin" });
        if (!res.ok) throw new Error("events");
        const pack = await res.json();
        const rows = pack.events || [];
        const list = rows.length
          ? "<div class='event-list'><table><thead><tr><th>זמן</th><th>סוג</th><th>יעד</th><th>תוכן</th></tr></thead><tbody>" +
            rows.map(function (item) {
              return "<tr><td>" + fmtDate(item.at) + "</td><td><span class='badge " + kindClass(item.kind) + "'>" +
                kindLabel(item.kind) + "</span></td><td>" + esc(item.channel) + " · " + item.targets +
                "</td><td class='note'>" + esc(item.text || item.status) + "</td></tr>";
            }).join("") + "</tbody></table></div>"
          : "<div class='empty'>אין אירועים למשתמש הזה</div>";
        showSheet(pack.name || "משתמש", "<div class='kv'>" +
          kv("שם", esc(pack.name)) +
          kv("טלפון", esc(pack.phone)) +
          kv("אירועים", String(rows.length)) +
          "</div>" + list);
      } catch (err) {
        showSheet("אירועים", "<div class='empty'>לא ניתן לטעון את האירועים</div>");
      }
    });

    document.getElementById("inbox").addEventListener("click", function (ev) {
      const row = ev.target.closest("[data-inbox]");
      if (!row || !lastData) return;
      const item = (lastData.inbox || []).find(function (x) { return x.id === row.getAttribute("data-inbox"); });
      if (!item) return;
      showSheet("כתבו לנו", "<div class='kv'>" +
        kv("זמן", esc(fmtDate(item.at))) +
        kv("שם", esc(item.name)) +
        kv("טלפון", esc(item.phone)) +
        kv("הודעה", esc(item.text)) +
        "</div>");
    });

    document.getElementById("sheet-close").addEventListener("click", function () {
      sheet.classList.add("hidden");
    });
    sheet.addEventListener("click", function (ev) {
      if (ev.target === sheet) sheet.classList.add("hidden");
    });

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

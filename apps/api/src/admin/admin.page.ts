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
    .status-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    button, .btn {
      background: transparent; color: var(--text); border: 1px solid var(--line);
      border-radius: 10px; padding: 8px 12px; cursor: pointer; font: inherit;
    }
    button:hover { border-color: var(--accent); }
    .pulse-btn {
      min-width: 118px; font-weight: 800; letter-spacing: .04em;
      border-width: 2px; transition: background .2s, color .2s, border-color .2s, box-shadow .2s;
    }
    .pulse-btn.ok {
      color: #062416; background: var(--green); border-color: #9af0c4;
      box-shadow: 0 0 0 3px rgba(61,214,140,.18);
    }
    .pulse-btn.bad {
      color: #fff; background: var(--red); border-color: #ff9aa4;
      animation: blink-red 1s ease-in-out infinite;
    }
    @keyframes blink-red {
      0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(255,93,108,.55); }
      50% { opacity: .55; box-shadow: 0 0 0 10px rgba(255,93,108,0); }
    }
    main { padding: 22px; display: grid; gap: 18px; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 16px; }
    .kpi .label { color: var(--muted); font-size: 12px; }
    .kpi .value { font-size: 28px; font-weight: 800; margin-top: 4px; }
    .odo-wrap {
      width: min(520px, 100%); margin: 0 auto; text-align: center;
      background: transparent; border: 2px solid #ffffff; border-radius: 18px;
      padding: 22px 28px; display: grid; gap: 10px; justify-items: center;
    }
    .odo-label { color: var(--muted); font-size: 13px; font-weight: 700; letter-spacing: .08em; }
    .odo {
      font-size: clamp(34px, 7vw, 58px); font-weight: 800; letter-spacing: .14em;
      font-variant-numeric: tabular-nums; color: var(--blue); direction: ltr; unicode-bidi: isolate;
    }
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
    .danger { border-color: var(--red); color: var(--red); }
    .okbtn { border-color: var(--green); color: var(--green); }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    #sheet { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: grid; place-items: center; z-index: 8; padding: 16px; }
    .sheet-card { width: min(720px, 96vw); max-height: 80vh; overflow: auto; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 18px; }
    .kv { display: grid; grid-template-columns: 110px 1fr; gap: 8px 12px; }
    .kv b { color: var(--muted); font-weight: 700; }
    .event-list { max-height: 52vh; overflow: auto; border: 1px solid var(--line); border-radius: 12px; margin-top: 12px; }
    .issue { padding: 10px 0; border-bottom: 1px solid var(--line); }
    .issue:last-child { border-bottom: 0; }
    .thumbs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .thumbs a { display: block; }
    .thumbs img { width: 72px; height: 72px; object-fit: cover; border-radius: 10px; border: 1px solid var(--line); background: #0c0e12; }
    .ban-box { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
    .ban-box input {
      flex: 1; min-width: 180px; margin: 0; padding: 10px 12px; border-radius: 10px;
      border: 1px solid var(--line); background: #0c0e12; color: var(--text); font: inherit;
    }
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
    <div class="status-row">
      <button type="button" class="pulse-btn bad" id="btn-health">שרת</button>
      <button type="button" class="pulse-btn bad" id="btn-security">אבטחה</button>
    </div>
    <div class="meta">
      <span id="updated">ממתין…</span>
      <span id="uptime"></span>
      <button type="button" id="logout">יציאה</button>
    </div>
  </header>
  <main>
    <section class="odo-wrap">
      <div class="odo-label">סה״כ הורדות</div>
      <div class="odo" id="k-total-down">00000000</div>
    </section>
    <section class="kpis">
      <div class="card kpi"><div class="label">סוקטים פעילים</div><div class="value" id="k-sockets">—</div></div>
      <div class="card kpi"><div class="label">משתמשים מחוברים</div><div class="value" id="k-users">—</div></div>
      <div class="card kpi"><div class="label">חדרים פעילים</div><div class="value" id="k-rooms">—</div></div>
      <div class="card kpi"><div class="label">שיחות חיות</div><div class="value" id="k-calls">—</div></div>
      <div class="card kpi"><div class="label">הורדות היום</div><div class="value" id="k-down">—</div></div>
      <div class="card kpi"><div class="label">כתבו לנו</div><div class="value" id="k-inbox">—</div></div>
      <div class="card kpi"><div class="label">תגובות חסימה</div><div class="value" id="k-appeals">—</div></div>
      <div class="card kpi"><div class="label">דיווחים</div><div class="value" id="k-reports">—</div></div>
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
      <div class="head"><h2>דיווחים</h2><span class="meta" id="reports-meta"></span></div>
      <div class="ban-box">
        <input id="ban-phone" type="tel" placeholder="חסימה לפי מספר · למשל +9725..." />
        <button type="button" class="danger" id="ban-phone-btn">חסום מספר</button>
        <button type="button" class="okbtn" id="unban-phone-btn">שחרר מספר</button>
      </div>
      <div id="reports" class="scroll"><div class="empty">אין דיווחים</div></div>
    </section>
    <section class="card">
      <div class="head"><h2>תגובות על חסימה / דיווח</h2><span class="meta" id="appeals-meta"></span></div>
      <div id="appeals" class="scroll"><div class="empty">אין תגובות מחסומים</div></div>
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
    const btnHealth = document.getElementById("btn-health");
    const btnSecurity = document.getElementById("btn-security");
    let timer = 0;
    let lastData = null;
    let eventsOpen = false;
    let eventsScroll = 0;
    let linkOk = false;

    function kindClass(kind) {
      if (kind === "walkie") return "walkie";
      if (kind === "text") return "text";
      if (kind === "call") return "call";
      return "voice";
    }

    function kindLabel(kind) {
      if (kind === "walkie") return "ווקי";
      if (kind === "text") return "הודעה";
      if (kind === "voice") return "הודעת קול";
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

    function fmtDownloads(n) {
      const num = Number(n) || 0;
      if (num >= 1000000) return num.toLocaleString("en-US");
      return String(num).padStart(8, "0");
    }

    function esc(value) {
      return String(value || "").replace(/[&<>"']/g, function (ch) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
      });
    }

    function kv(label, value) {
      return "<b>" + esc(label) + "</b><div class='note'>" + (value || "—") + "</div>";
    }

    function thumbsHtml(images) {
      const list = images || [];
      if (!list.length) return "";
      return "<div class='thumbs'>" + list.map(function (src) {
        const url = String(src || "");
        return "<a href='" + esc(url) + "' target='_blank' rel='noopener'><img src='" + esc(url) + "' alt=''></a>";
      }).join("") + "</div>";
    }

    function noteRow(row, kind) {
      const badge = kind === "appeal"
        ? (row.banned ? "<span class='badge call'>חסום</span>" : "<span class='badge text'>שוחרר</span>")
        : ((row.images && row.images.length) ? "<span class='badge text'>" + row.images.length + " תמונות</span>" : "");
      return "<tr class='clickable' data-" + kind + "='" + esc(row.id) + "'><td>" + fmtDate(row.at) +
        "</td><td>" + esc(row.name) + "<div class='meta'>" + esc(row.phone) + "</div></td><td class='clip'>" +
        esc(row.text) + "</td><td>" + badge + "</td></tr>";
    }

    function showSheet(title, html) {
      document.getElementById("sheet-title").textContent = title;
      document.getElementById("sheet-body").innerHTML = html;
      sheet.classList.remove("hidden");
    }

    function setPulse(btn, ok, okText, badText) {
      btn.classList.toggle("ok", ok);
      btn.classList.toggle("bad", !ok);
      btn.textContent = ok ? okText : badText;
    }

    function paintStatus() {
      const healthOk = linkOk && Boolean(lastData && lastData.health && lastData.health.ok);
      const securityOk = linkOk && Boolean(lastData && lastData.security && lastData.security.ok);
      setPulse(btnHealth, healthOk, "שרת תקין", "שרת תקלה");
      setPulse(btnSecurity, securityOk, "אבטחה תקינה", "אבטחה בסיכון");
      liveDot.classList.toggle("ok", healthOk);
    }

    function renderHealthSheet() {
      if (!linkOk) {
        showSheet("מצב שרת", "<div class='issue'><b>אין חיבור לשרת</b><div class='note'>הדשבורד לא מצליח לקבל snapshot. בדקו Render / דיפלוי / מאגר DB.</div></div>");
        return;
      }
      const health = (lastData && lastData.health) || { ok: false, issues: ["אין נתוני בריאות"], openErrors: 0, dbOk: false, dbMs: 0 };
      const incidents = ((lastData && lastData.incidents) || []).filter(function (row) { return row.kind !== "security"; });
      const issues = (health.issues || []).map(function (text) {
        return "<div class='issue'><b>בעיה</b><div class='note'>" + esc(text) + "</div></div>";
      }).join("");
      const rows = incidents.length
        ? "<div class='event-list'><table><thead><tr><th>זמן</th><th>סוג</th><th>נתיב</th><th>הודעה</th></tr></thead><tbody>" +
          incidents.map(function (row) {
            return "<tr><td>" + fmtDate(row.at) + "</td><td>" + esc(row.kind) + " " + row.status +
              "</td><td>" + esc(row.method + " " + row.path) + "</td><td class='note'>" +
              esc(row.message) + (row.detail ? "<div class='meta'>" + esc(row.detail) + "</div>" : "") +
              "</td></tr>";
          }).join("") + "</tbody></table></div>"
        : "<div class='empty'>אין שגיאות שרת שמורות</div>";
      showSheet("מצב שרת", "<div class='kv'>" +
        kv("מצב", health.ok ? "ירוק · תקין" : "אדום · יש תקלה") +
        kv("מסד נתונים", health.dbOk ? ("תקין · " + health.dbMs + "ms") : "לא זמין") +
        kv("שגיאות פתוחות", String(health.openErrors || 0)) +
        "</div>" +
        (issues || "") +
        "<div class='head' style='margin-top:16px'><h2>יומן שגיאות</h2>" +
        "<button type='button' id='clear-incidents'>נקה יומן</button></div>" +
        rows);
      const clearBtn = document.getElementById("clear-incidents");
      if (clearBtn) {
        clearBtn.onclick = async function () {
          await fetch("/admin/api/incidents/clear", { method: "POST", credentials: "same-origin" });
          await pull();
          renderHealthSheet();
        };
      }
    }

    function renderSecuritySheet() {
      if (!linkOk) {
        showSheet("אבטחה", "<div class='issue'><b>אין חיבור</b><div class='note'>לא ניתן לבדוק אבטחה בלי snapshot חי.</div></div>");
        return;
      }
      const security = (lastData && lastData.security) || { ok: false, findings: ["אין נתוני אבטחה"], openFindings: 0 };
      const findings = (security.findings || []).map(function (text) {
        return "<div class='issue'><b>ממצא</b><div class='note'>" + esc(text) + "</div></div>";
      }).join("") || "<div class='empty'>אין ממצאי אבטחה פתוחים</div>";
      const incidents = ((lastData && lastData.incidents) || []).filter(function (row) { return row.kind === "security"; });
      const rows = incidents.length
        ? "<div class='event-list'><table><thead><tr><th>זמן</th><th>נתיב</th><th>הודעה</th></tr></thead><tbody>" +
          incidents.map(function (row) {
            return "<tr><td>" + fmtDate(row.at) + "</td><td>" + esc(row.method + " " + row.path) +
              "</td><td class='note'>" + esc(row.message) + "</td></tr>";
          }).join("") + "</tbody></table></div>"
        : "<div class='empty'>אין אירועי אבטחה אחרונים</div>";
      showSheet("אבטחה", "<div class='kv'>" +
        kv("מצב", security.ok ? "ירוק · הכל כשורה" : "אדום · יש סיכון") +
        kv("ממצאים", String(security.openFindings || 0)) +
        "</div>" + findings +
        "<div class='head' style='margin-top:16px'><h2>ניסיונות חשודים</h2></div>" + rows);
    }

    function render(data) {
      lastData = data;
      linkOk = true;
      document.getElementById("k-sockets").textContent = data.sockets;
      document.getElementById("k-users").textContent = data.usersOnline;
      document.getElementById("k-rooms").textContent = data.roomsActive;
      document.getElementById("k-calls").textContent = data.callsLive;
      document.getElementById("k-total-down").textContent = fmtDownloads(data.usersTotal);
      document.getElementById("k-down").textContent = data.downloadsToday;
      document.getElementById("k-inbox").textContent = data.inboxCount;
      document.getElementById("k-appeals").textContent = data.appealsCount || 0;
      document.getElementById("k-reports").textContent = data.reportsCount || 0;
      document.getElementById("updated").textContent = "עודכן " + new Date(data.at).toLocaleTimeString("he-IL");
      document.getElementById("uptime").textContent = fmtUptime(data.uptimeSec);
      document.getElementById("down-meta").textContent = "השבוע " + (data.downloadsWeek || 0) + " · היום " + (data.downloadsToday || 0);
      document.getElementById("inbox-meta").textContent = (data.inboxCount || 0) + " הודעות";
      document.getElementById("appeals-meta").textContent = (data.appealsCount || 0) + " תגובות";
      document.getElementById("reports-meta").textContent = (data.reportsCount || 0) + " דיווחים";
      eventsBox.classList.toggle("open", eventsOpen);
      document.getElementById("events-all").textContent = eventsOpen ? "הקטן" : "הצג הכל";
      paintStatus();

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
        ? "<table><thead><tr><th>מתי</th><th>מי</th><th>הודעה</th><th></th></tr></thead><tbody>" +
          inbox.map(function (row) { return noteRow(row, "inbox"); }).join("") + "</tbody></table>"
        : "<div class='empty'>עדיין לא נשלחו הודעות מכתבו לנו</div>";

      const appeals = data.appeals || [];
      document.getElementById("appeals").innerHTML = appeals.length
        ? "<table><thead><tr><th>מתי</th><th>מי כתב</th><th>תגובה</th><th>מצב</th></tr></thead><tbody>" +
          appeals.map(function (row) { return noteRow(row, "appeal"); }).join("") + "</tbody></table>"
        : "<div class='empty'>אין תגובות מחסומים</div>";

      const reports = data.reports || [];
      document.getElementById("reports").innerHTML = reports.length
        ? "<table><thead><tr><th>מתי</th><th>מי דיווח</th><th>על מי</th><th>סיבה</th><th>מצב</th><th></th></tr></thead><tbody>" +
          reports.map(function (row) {
            const banned = row.targetBanned;
            const canBan = row.targetKind !== "group";
            const actions = canBan
              ? (banned
                  ? "<button type='button' class='okbtn' data-unban='" + esc(row.targetId) + "'>שחרר</button>"
                  : "<button type='button' class='danger' data-ban='" + esc(row.targetId) + "'>חסום</button>")
              : "<span class='meta'>קבוצה</span>";
            return "<tr class='clickable' data-report='" + esc(row.id) + "'><td>" + fmtDate(row.at) +
              "</td><td>" + esc(row.reporterName) + "<div class='meta'>" + esc(row.reporterPhone) +
              "</div></td><td>" + esc(row.targetName) + "<div class='meta'>" + esc(row.targetPhone) +
              "</div></td><td class='clip'>" + esc(row.reason) + "</td><td>" +
              (banned ? "<span class='badge call'>חסום</span>" : "<span class='badge text'>פעיל</span>") +
              "</td><td class='actions'>" + actions + "</td></tr>";
          }).join("") + "</tbody></table>"
        : "<div class='empty'>אין דיווחים</div>";

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

    btnHealth.addEventListener("click", renderHealthSheet);
    btnSecurity.addEventListener("click", renderSecuritySheet);

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

    document.getElementById("reports").addEventListener("click", async function (ev) {
      const ban = ev.target.closest("[data-ban]");
      const unban = ev.target.closest("[data-unban]");
      if (ban || unban) {
        ev.stopPropagation();
        const id = (ban || unban).getAttribute(ban ? "data-ban" : "data-unban");
        if (ban && !confirm("לחסום את המשתמש מהאפליקציה?")) return;
        const path = ban ? "/admin/api/people/" + encodeURIComponent(id) + "/ban" : "/admin/api/people/" + encodeURIComponent(id) + "/unban";
        const res = await fetch(path, { method: "POST", credentials: "same-origin" });
        if (!res.ok) {
          alert("לא ניתן לעדכן את החסימה");
          return;
        }
        await pull();
        return;
      }
      const row = ev.target.closest("[data-report]");
      if (!row || !lastData) return;
      const item = (lastData.reports || []).find(function (x) { return x.id === row.getAttribute("data-report"); });
      if (!item) return;
      showSheet("דיווח", "<div class='kv'>" +
        kv("זמן", esc(fmtDate(item.at))) +
        kv("מי דיווח", esc(item.reporterName) + " · " + esc(item.reporterPhone)) +
        kv("על מי", esc(item.targetName) + " · " + esc(item.targetPhone)) +
        kv("סוג", item.targetKind === "group" ? "קבוצה" : "משתמש") +
        kv("סיבה", esc(item.reason)) +
        kv("מצב", item.targetBanned ? "חסום" : "פעיל") +
        "</div>");
    });

    function openNoteSheet(title, item, allowUnban) {
      const actions = allowUnban && item.banned
        ? "<div class='actions' style='margin-top:14px'><button type='button' class='okbtn' id='sheet-unban'>שחרר מחסימה</button></div>"
        : "";
      showSheet(title, "<div class='kv'>" +
        kv("זמן", esc(fmtDate(item.at))) +
        kv("שם", esc(item.name)) +
        kv("טלפון", esc(item.phone)) +
        kv("הודעה", esc(item.text)) +
        kv("מצב", item.banned ? "חסום" : "פעיל") +
        "</div>" + thumbsHtml(item.images) + actions);
      const unbanBtn = document.getElementById("sheet-unban");
      if (unbanBtn) {
        unbanBtn.onclick = async function () {
          const res = await fetch("/admin/api/people/" + encodeURIComponent(item.userId) + "/unban", {
            method: "POST", credentials: "same-origin"
          });
          if (!res.ok) {
            alert("לא ניתן לשחרר");
            return;
          }
          await pull();
          sheet.classList.add("hidden");
        };
      }
    }

    document.getElementById("inbox").addEventListener("click", function (ev) {
      const row = ev.target.closest("[data-inbox]");
      if (!row || !lastData) return;
      const item = (lastData.inbox || []).find(function (x) { return x.id === row.getAttribute("data-inbox"); });
      if (!item) return;
      openNoteSheet("כתבו לנו", item, false);
    });

    document.getElementById("appeals").addEventListener("click", function (ev) {
      const row = ev.target.closest("[data-appeal]");
      if (!row || !lastData) return;
      const item = (lastData.appeals || []).find(function (x) { return x.id === row.getAttribute("data-appeal"); });
      if (!item) return;
      openNoteSheet("תגובה על חסימה", item, true);
    });

    async function banByPhone(ban) {
      const phone = document.getElementById("ban-phone").value.trim();
      if (!phone) {
        alert("הזינו מספר טלפון");
        return;
      }
      if (ban && !confirm("לחסום את המספר " + phone + "?")) return;
      const path = ban ? "/admin/api/people/ban-phone" : "/admin/api/people/unban-phone";
      const res = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone })
      });
      if (!res.ok) {
        const err = await res.json().catch(function () { return {}; });
        alert(err.message || "לא ניתן לעדכן חסימה");
        return;
      }
      document.getElementById("ban-phone").value = "";
      await pull();
    }
    document.getElementById("ban-phone-btn").addEventListener("click", function () { banByPhone(true); });
    document.getElementById("unban-phone-btn").addEventListener("click", function () { banByPhone(false); });

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
          linkOk = false;
          paintStatus();
          return;
        }
        if (res.status === 503) {
          loginErr.textContent = "חסר ADMIN_DASHBOARD_TOKEN בשרת.";
          gate.classList.remove("hidden");
          linkOk = false;
          paintStatus();
          return;
        }
        if (!res.ok) throw new Error("snapshot " + res.status);
        gate.classList.add("hidden");
        render(await res.json());
      } catch (err) {
        linkOk = false;
        document.getElementById("updated").textContent = "אין חיבור לשרת";
        paintStatus();
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

    paintStatus();
    pull();
    timer = setInterval(pull, 2500);
  </script>
</body>
</html>
`;

const base = "http://localhost:3000";

async function json(path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function signup(phone, name, speakLang, listenLang) {
  await json("/auth/otp/request", { method: "POST", body: JSON.stringify({ phone }) });
  const auth = await json("/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ phone, code: "000000" }),
  });
  const user = await json("/users/me", {
    method: "PATCH",
    headers: { Authorization: `Bearer ${auth.token}` },
    body: JSON.stringify({ displayName: name, speakLang, listenLang }),
  });
  return { token: auth.token, user };
}

const a = await signup("0501111111", "Raphael", "he", "he");
const b = await signup("0502222222", "Amit", "en", "en");

const contacts = await json("/contacts/sync", {
  method: "POST",
  headers: { Authorization: `Bearer ${a.token}` },
  body: JSON.stringify({
    contacts: [
      { phone: "0502222222", displayName: "Amit" },
      { phone: "0503333333", displayName: "Guest" },
    ],
  }),
});

const invite = await json("/contacts/invite", {
  method: "POST",
  headers: { Authorization: `Bearer ${a.token}` },
  body: JSON.stringify({ phone: "0503333333", displayName: "Guest" }),
});

const wav = Buffer.from(
  "524946462400000057415645666d7420100000000100010044ac000088580100020010006461746100000000",
  "hex",
);
const form = new FormData();
form.append("audio", new Blob([wav], { type: "audio/wav" }), "ptt.wav");
form.append("targetUserIds", JSON.stringify([b.user.id]));
form.append("durationMs", "1200");
const txRes = await fetch(`${base}/transmissions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${a.token}` },
  body: form,
});
const tx = await txRes.json();
if (!txRes.ok) throw new Error(`tx ${txRes.status} ${JSON.stringify(tx)}`);

await new Promise((r) => setTimeout(r, 400));
const history = await json("/transmissions", {
  headers: { Authorization: `Bearer ${b.token}` },
});

const everyone = await fetch(`${base}/transmissions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${a.token}` },
  body: (() => {
    const f = new FormData();
    f.append("audio", new Blob([wav], { type: "audio/wav" }), "ptt.wav");
    f.append("everyone", "true");
    f.append("durationMs", "900");
    return f;
  })(),
});
const everyoneJson = await everyone.json();

console.log(
  JSON.stringify(
    {
      phones: [a.user.phoneE164, b.user.phoneE164],
      matched: contacts.filter((c) => c.matchedUser).map((c) => c.displayName),
      unmatched: contacts.filter((c) => !c.matchedUser).map((c) => c.displayName),
      invitePreview: invite.smsBody.slice(0, 50),
      transmission: tx,
      history: history.length,
      everyone: everyoneJson,
      health: await json("/health"),
    },
    null,
    2,
  ),
);

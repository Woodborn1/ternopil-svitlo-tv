const https = require("https");
const fs = require("fs");
const path = require("path");
const lgtv = require("lgtv2");

const CONFIG_PATH = path.join(__dirname, "config.json");
const KEY_FILE = path.join(__dirname, ".lgtv-key");
const DATA_URL =
  "https://raw.githubusercontent.com/yaroslav2901/OE_OUTAGE_DATA/main/data/Ternopiloblenerho.json";

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const TV_IP = process.env.TV_IP || config.tvIp;
const QUEUE = process.env.QUEUE || config.queue || "GPV5.1";
const POLL_MS = (config.pollIntervalMinutes || 2) * 60 * 1000;
const NOTIFY_BEFORE = config.notifyBeforeMinutes || [30, 20, 10];
const NOTICE_MS = (config.noticeSeconds || 60) * 1000; // how long each notice stays on screen
const TOAST_REPEAT_MS = 5000;
const NOTIFY_ON_MAYBE = config.notifyOnMaybe !== false;
const IS_TEST = process.argv.includes("--test");
const IS_TEST_CHANGE = process.argv.includes("--test-change");
const IS_TEST_WARNING = process.argv.includes("--test-warning");

let tvClient = null;
let tvConnected = false;
let lastScheduleSnapshot = null;
let lastSourceUpdate = null;
let latestDays = [];
const sentReminders = new Set(); // key: `${slotStartMs}_${minutesBefore}`

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            "User-Agent": "ternopil-svitlo-tv-notifier/1.0",
            "Cache-Control": "no-cache",
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error("HTTP " + res.statusCode));
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          });
        }
      )
      .on("error", reject);
  });
}

function connectTv() {
  console.log(`[TV] Підключення до LG webOS за адресою ws://${TV_IP}:3000 ...`);
  console.log("[TV] При першому підключенні натисніть 'Прийняти' (Accept) на екрані телевізора!");

  tvClient = lgtv({
    url: `ws://${TV_IP}:3000`,
    keyFile: KEY_FILE,
    reconnect: 10000,
    timeout: 15000,
  });

  tvClient.on("connect", () => {
    tvConnected = true;
    console.log("[TV] Підключено успішно!");
    if (IS_TEST_WARNING) {
      sendToast(`Через 30 хвилин не буде світла! (тест, черга ${QUEUE.replace("GPV", "")})`);
      setTimeout(() => process.exit(0), NOTICE_MS + 3000);
    } else if (IS_TEST_CHANGE) {
      pollSchedule().then(() => {
        sendToast(`Графік (черга ${QUEUE.replace("GPV", "")}) змінився! ${describeOutages(latestDays)}`);
        setTimeout(() => process.exit(0), NOTICE_MS + 3000);
      });
    } else if (IS_TEST) {
      sendToast(`Тест: Черга ${QUEUE.replace("GPV", "")} підключена! Сповіщення працюють.`);
      setTimeout(() => process.exit(0), NOTICE_MS + 3000);
    }
  });

  tvClient.on("close", () => {
    if (tvConnected) console.log("[TV] З'єднання закрито (телевізор вимкнено?). Перепідключення...");
    tvConnected = false;
  });

  tvClient.on("error", (err) => {
    // TV may simply be powered off; reconnect loop handles it quietly
    if (IS_TEST) {
      console.error("[TV ERROR]", err.message);
    }
  });
}

function sendToast(message) {
  const ts = new Date().toLocaleTimeString("uk-UA");
  console.log(`[${ts}] TOAST -> ${message}`);
  if (!tvConnected || !tvClient) {
    console.log("  (Телевізор зараз не в мережі / вимкнений, сповіщення пропущено)");
    return;
  }
  // A plain toast vanishes after ~5 s. Prefer an alert window that we close
  // ourselves after NOTICE_MS; if the TV refuses alerts, repeat the toast.
  tvClient.request(
    "ssap://system.notifications/createAlert",
    { message, buttons: [{ label: "OK" }] },
    (err, res) => {
      if (!err && res && res.alertId) {
        setTimeout(() => {
          if (tvConnected) {
            tvClient.request("ssap://system.notifications/closeAlert", { alertId: res.alertId }, () => {});
          }
        }, NOTICE_MS);
        return;
      }
      console.log("  (alert недоступний, повторюю звичайне сповіщення)", err ? err.message || err : "");
      repeatToast(message);
    }
  );
}

function repeatToast(message) {
  const endAt = Date.now() + NOTICE_MS;
  const send = () => {
    if (!tvConnected || Date.now() >= endAt) return;
    tvClient.request("ssap://system.notifications/createToast", { message }, (err) => {
      if (err) console.error("[TV TOAST ERROR]", err.message || err);
    });
    setTimeout(send, TOAST_REPEAT_MS);
  };
  send();
}

function hourToHalves(code) {
  if (code === "no") return ["off", "off"];
  if (code === "first") return ["off", "on"];
  if (code === "second") return ["on", "off"];
  if (code === "maybe") return ["maybe", "maybe"];
  if (code === "mfirst") return ["maybe", "on"];
  if (code === "msecond") return ["on", "maybe"];
  return ["on", "on"];
}

function buildTimeline(days) {
  const slots = [];
  for (const day of days) {
    const dayMs = day.timestamp * 1000;
    const hours = day.hours || {};
    for (let h = 1; h <= 24; h++) {
      const halves = hourToHalves(hours[String(h)]);
      const baseMs = dayMs + (h - 1) * 3600 * 1000;
      slots.push({ startMs: baseMs, state: halves[0] });
      slots.push({ startMs: baseMs + 1800 * 1000, state: halves[1] });
    }
  }
  return slots;
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function fmtTime(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Upcoming outage intervals, e.g. "Відключення: сьогодні 14:00-17:00; завтра 08:00-11:00"
function describeOutages(days) {
  const slots = buildTimeline(days);
  const nowMs = Date.now();
  const isOut = (s) => s.state === "off" || (NOTIFY_ON_MAYBE && s.state === "maybe");
  const intervals = [];
  for (let i = 0; i < slots.length; i++) {
    if (!isOut(slots[i])) continue;
    let j = i;
    let maybeOnly = true;
    while (j < slots.length && isOut(slots[j])) {
      if (slots[j].state === "off") maybeOnly = false;
      j++;
    }
    const startMs = slots[i].startMs;
    const endMs = slots[j - 1].startMs + 1800 * 1000;
    if (endMs > nowMs) intervals.push({ startMs, endMs, maybeOnly });
    i = j - 1;
  }
  if (!intervals.length) return "Відключень не заплановано.";

  const todayKey = new Date(nowMs).toDateString();
  const tomorrowKey = new Date(nowMs + 86400000).toDateString();
  const groups = [];
  for (const iv of intervals) {
    const key = new Date(iv.startMs).toDateString();
    const label = key === todayKey ? "сьогодні" : key === tomorrowKey ? "завтра" : (() => {
      const d = new Date(iv.startMs);
      return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
    })();
    const end = fmtTime(iv.endMs) === "00:00" ? "24:00" : fmtTime(iv.endMs);
    const text = `${fmtTime(iv.startMs)}-${end}${iv.maybeOnly ? " (можл.)" : ""}`;
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(text);
    else groups.push({ label, items: [text] });
  }
  return "Відключення: " + groups.map((g) => `${g.label} ${g.items.join(", ")}`).join("; ");
}

async function pollSchedule() {
  try {
    const raw = await fetchJson(DATA_URL);
    const factData = (raw && raw.fact && raw.fact.data) || {};
    const dayKeys = Object.keys(factData).sort();

    const days = dayKeys.map((k) => ({
      timestamp: Number(k),
      hours: (factData[k] && factData[k][QUEUE]) || {},
    }));

    const snapshot = JSON.stringify(days);
    const sourceUpdate = (raw.fact && raw.fact.update) || raw.lastUpdated || "";

    if (lastScheduleSnapshot !== null && snapshot !== lastScheduleSnapshot) {
      const qLabel = QUEUE.replace("GPV", "");
      sendToast(`Графік (черга ${qLabel}) змінився! ${describeOutages(days)}`);
      // Clear upcoming reminders so new times get notified cleanly
      sentReminders.clear();
    }

    lastScheduleSnapshot = snapshot;
    lastSourceUpdate = sourceUpdate;
    latestDays = days;
  } catch (err) {
    console.error("[POLL ERROR]", err.message);
  }
}

function checkUpcomingOutages() {
  if (!latestDays.length) return;
  const slots = buildTimeline(latestDays);
  const nowMs = Date.now();

  let currIdx = -1;
  for (let i = 0; i < slots.length; i++) {
    if (nowMs >= slots[i].startMs && nowMs < slots[i].startMs + 1800 * 1000) {
      currIdx = i;
      break;
    }
  }
  if (currIdx === -1) return;

  const currState = slots[currIdx].state;
  // Only warn before outage when power is currently ON
  if (currState !== "on") return;

  // Find next transition to OFF (or MAYBE if enabled)
  for (let j = currIdx + 1; j < slots.length; j++) {
    const s = slots[j];
    const isTarget = s.state === "off" || (NOTIFY_ON_MAYBE && s.state === "maybe");
    if (!isTarget) continue;

    const minsLeft = Math.round((s.startMs - nowMs) / 60000);
    const dt = new Date(s.startMs);
    const timeStr = `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
    const qLabel = QUEUE.replace("GPV", "");

    for (const threshold of NOTIFY_BEFORE) {
      // Trigger within a 2-minute window so polling never misses it
      if (minsLeft <= threshold && minsLeft >= threshold - 2) {
        const key = `${s.startMs}_${threshold}`;
        if (!sentReminders.has(key)) {
          sentReminders.add(key);
          const kind = s.state === "off" ? "не буде світла" : "можливо не буде світла";
          sendToast(`Через ${threshold} хвилин ${kind}! (о ${timeStr}, черга ${qLabel})`);
        }
      }
    }
    break;
  }
}

connectTv();

if (!IS_TEST && !IS_TEST_CHANGE && !IS_TEST_WARNING) {
  console.log(`[START] Моніторинг Тернопільобленерго для черги ${QUEUE} (інтервал ${POLL_MS / 60000} хв)`);
  pollSchedule().then(checkUpcomingOutages);
  setInterval(pollSchedule, POLL_MS);
  setInterval(checkUpcomingOutages, 30 * 1000);
}

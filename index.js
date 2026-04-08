import Imap from "imap";
import { simpleParser } from "mailparser";
import fetch from "node-fetch";

const { GEMINI_API_KEY, YAHOO_USER, YAHOO_PASS } = process.env;

const MODEL = "gemini-3.1-flash-lite-preview";

const FOLDERS = {
  TEMP: "Temp",
  MARKETING: "Marketing",
  JOBS: "Jobs",
  FINANCE: "Finance",
  TRAVEL: "Travel",
};

const VALID_LABELS = new Set(["TEMP", "MARKETING", "JOBS", "FINANCE", "TRAVEL", "STAR", "SKIP"]);

function createImapClient() {
  return new Imap({
    user: YAHOO_USER,
    password: YAHOO_PASS,
    host: "imap.mail.yahoo.com",
    port: 993,
    tls: true,
    connTimeout: 30000,
    authTimeout: 15000,
  });
}

// ── Gemini API ────────────────────────────────────

async function classifyEmails(emails) {
  const emailList = emails
    .map((e, i) => `[${i}] Subject: ${e.subject}\nBody: ${e.body}`)
    .join("\n\n");

  const prompt = `
Classify each email into EXACTLY one of:
TEMP, MARKETING, JOBS, FINANCE, TRAVEL, STAR, SKIP

Rules:
- TEMP: OTP codes, verification codes, 2FA, CI/deploy notifications (e.g. GitHub Actions), password resets, security alerts (e.g. "app password created/deleted", "sign-in detected"), ephemeral notifications
- MARKETING: promotional emails, deals, newsletters, ads, unsolicited outreach, sales campaigns, loyalty programs, "we miss you" emails, subscription marketing, travel deals/offers (NOT actual bookings)
- JOBS: any job platform emails — job alerts, recommendations, application confirmations, interview scheduling, rejections, recruiter outreach, "exciting role" emails
- FINANCE: bank emails (statements, transaction alerts, UPI notifications, payment confirmations, credit card updates), subscription charges, receipts, invoices
- TRAVEL: actual booking confirmations, itineraries, PNR details, boarding passes, hotel/flight/train confirmations (NOT travel marketing/deals)
- STAR: the email is from a real person and requires the user to reply or take a specific action (submit a document, provide information, approve something). Also use for finance emails that explicitly ask the user to do something (e.g. "submit KYC documents").
- SKIP: genuinely does not fit ANY category above. This should be very rare.

Important:
- SKIP should almost never be used — most emails fit into one of the categories above
- Informational alerts (password changed, sign-in detected, deploy failed) are TEMP, not STAR
- STAR is ONLY for emails where a human is waiting for the user's response or where the user must take explicit action
- Bank/finance emails default to FINANCE — only STAR if they explicitly ask the user to submit/provide/verify something
- Job platform emails are ALWAYS JOBS even if they look like marketing
- Promotional emails are ALWAYS MARKETING even if from a known brand like a bank or airline
- OTPs, security alerts, and deploy notifications are ALWAYS TEMP

Emails:
${emailList}

Return one label per email, one per line, in format: [index] LABEL
Example:
[0] MARKETING
[1] TEMP
[2] FINANCE
`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    );
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
      console.error("API error:", JSON.stringify(data?.error || data));
      return emails.map(() => "SKIP");
    }

    const labels = Array.from({ length: emails.length }, () => "SKIP");
    for (const line of raw.split("\n")) {
      const match = line.match(/\[(\d+)\]\s*(\w+)/);
      if (match) {
        const idx = parseInt(match[1], 10);
        const label = match[2].toUpperCase();
        if (idx < emails.length && VALID_LABELS.has(label)) {
          labels[idx] = label;
        }
      }
    }
    return labels;
  } catch (e) {
    console.error("Fetch error:", e.message);
    return emails.map(() => "SKIP");
  }
}

// ── IMAP helpers ──────────────────────────────────

function imapOp(imap, method, ...args) {
  return new Promise((resolve, reject) => {
    imap[method](...args, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

function ensureFolder(imap, folder) {
  return new Promise((resolve) => {
    imap.addBox(folder, () => resolve());
  });
}

function addFlags(imap, uid, flags) {
  return imapOp(imap, "addFlags", uid, flags);
}

function moveToFolder(imap, uid, folder) {
  return imapOp(imap, "move", uid, folder);
}

function parseMessage(msg) {
  return new Promise((resolve) => {
    let uid;
    let parsed;
    let parts = 0;

    function tryResolve() {
      if (++parts === 2) {
        resolve(uid && parsed ? { uid, parsed } : null);
      }
    }

    msg.once("attributes", (attrs) => {
      uid = attrs.uid;
      tryResolve();
    });

    msg.on("body", (stream) => {
      simpleParser(stream, (err, result) => {
        if (!err) parsed = result;
        tryResolve();
      });
    });
  });
}

function openBox(imap, box, readOnly = false) {
  return new Promise((resolve, reject) => {
    imap.openBox(box, readOnly, (err, mailbox) => {
      if (err) return reject(err);
      resolve(mailbox);
    });
  });
}

function search(imap, criteria) {
  return new Promise((resolve, reject) => {
    imap.search(criteria, (err, results) => {
      if (err) return reject(err);
      resolve(results || []);
    });
  });
}

function fetchAll(imap, results) {
  return new Promise((resolve) => {
    const messages = [];
    const fetcher = imap.fetch(results, { bodies: "" });
    fetcher.on("message", (msg) => {
      messages.push(parseMessage(msg));
    });
    fetcher.once("end", () => {
      Promise.all(messages).then(resolve);
    });
  });
}

function connectAndRun(fn) {
  const imap = createImapClient();
  return new Promise((resolve, reject) => {
    imap.once("ready", async () => {
      try {
        const result = await fn(imap);
        imap.end();
        resolve(result);
      } catch (e) {
        imap.end();
        reject(e);
      }
    });
    imap.once("error", reject);
    imap.connect();
  });
}

// ── Classify command ──────────────────────────────

async function classify() {
  const emails = await connectAndRun(async (imap) => {
    await openBox(imap, "INBOX", false);
    const results = await search(imap, ["UNFLAGGED"]);
    if (!results.length) return [];

    console.log(`Found ${results.length} unflagged email(s) to classify.`);
    const messages = (await fetchAll(imap, results)).filter(Boolean);

    return messages.map((msg) => {
      const subject = msg.parsed.subject || "";
      const text = msg.parsed.text
        || (msg.parsed.html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      return { uid: msg.uid, subject, body: text.slice(0, 800) };
    });
  });

  if (!emails.length) {
    console.log("No unflagged emails to classify.");
    return;
  }

  const actions = [];
  const BATCH_SIZE = 5;
  for (let start = 0; start < emails.length; start += BATCH_SIZE) {
    const batch = emails.slice(start, start + BATCH_SIZE);
    const labels = await classifyEmails(batch);

    for (let j = 0; j < batch.length; j++) {
      const label = labels[j];
      console.log(`  "${batch[j].subject}" → ${label}`);
      actions.push({ uid: batch[j].uid, label });
    }
  }

  const actionable = actions.filter((a) => a.label === "STAR" || FOLDERS[a.label]);
  if (!actionable.length) {
    console.log("No emails to move or star.");
    return;
  }

  await connectAndRun(async (imap) => {
    await openBox(imap, "INBOX", false);

    for (const { uid, label } of actionable) {
      if (label === "STAR") {
        await addFlags(imap, uid, "\\Flagged");
        console.log(`  UID ${uid}: starred`);
      } else {
        await ensureFolder(imap, FOLDERS[label]);
        try {
          await moveToFolder(imap, uid, FOLDERS[label]);
          console.log(`  UID ${uid}: moved to ${FOLDERS[label]}`);
        } catch (e) {
          console.error(`  UID ${uid}: failed to move — ${e.message}`);
        }
      }
    }
  });

  console.log("Done.");
}

// ── Cleanup command ───────────────────────────────

async function cleanup() {
  await connectAndRun(async (imap) => {
    try {
      await openBox(imap, "Temp", false);
    } catch {
      console.log("Temp folder does not exist. Nothing to clean up.");
      return;
    }

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const results = await search(imap, [["BEFORE", yesterday]]);
    if (!results.length) {
      console.log("No emails older than 24h in Temp.");
      return;
    }

    console.log(`Deleting ${results.length} email(s) older than 24h from Temp.`);
    await addFlags(imap, results, "\\Deleted");
    await new Promise((resolve, reject) => {
      imap.expunge((err) => (err ? reject(err) : resolve()));
    });
    console.log("Cleanup complete.");
  });
}

// ── CLI entry point ───────────────────────────────

const command = process.argv[2] || "classify";

if (command === "classify") {
  classify().catch((e) => {
    console.error("Classification failed:", e.message);
    process.exit(1);
  });
} else if (command === "cleanup") {
  cleanup().catch((e) => {
    console.error("Cleanup failed:", e.message);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${command}. Use "classify" or "cleanup".`);
  process.exit(1);
}

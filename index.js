import Imap from "imap";
import { simpleParser } from "mailparser";
import fetch from "node-fetch";

const { GEMINI_API_KEY, YAHOO_USER, YAHOO_PASS } = process.env;

const MODEL = "gemini-2.5-flash";

const FOLDERS = {
  TEMP: "Temp",
  MARKETING: "Marketing",
  JOBS: "Jobs",
  FINANCE: "Finance",
  TRAVEL: "Travel",
};

function createImapClient() {
  return new Imap({
    user: YAHOO_USER,
    password: YAHOO_PASS,
    host: "imap.mail.yahoo.com",
    port: 993,
    tls: true,
  });
}

async function classifyEmail(subject, body) {
  const prompt = `
Classify this email into EXACTLY one of:
TEMP, MARKETING, JOBS, FINANCE, TRAVEL, STAR, SKIP

Rules:
- TEMP: OTP codes, verification codes, 2FA, CI/deploy notifications (e.g. GitHub Actions), password resets, ephemeral alerts that expire quickly
- MARKETING: promotional emails, deals, newsletters, ads, unsolicited outreach, sales campaigns, subscription marketing
- JOBS: any job platform emails — job alerts, recommendations, application confirmations, interview scheduling, rejections, recruiter outreach
- FINANCE: bank emails (statements, transaction alerts, payment confirmations, credit card updates), subscription charges, receipts, invoices — UNLESS the email asks the user to take a specific action (submit documents, verify identity, respond to something)
- TRAVEL: booking confirmations, itineraries, PNR details, boarding passes, hotel/flight/train confirmations
- STAR: the email requires the user to DO something — reply, submit a document, verify, approve, take action by a deadline, or is a personal message from a real human. Also use STAR for bank/finance emails that require user action.
- SKIP: doesn't fit any category above and is not actionable

Important:
- If an email is actionable (requires user response/action), it is ALWAYS STAR regardless of its topic
- Bank/finance emails default to FINANCE unless they require action → then STAR
- Job platform emails are ALWAYS JOBS
- Promotional/marketing emails are ALWAYS MARKETING even if from a known brand
- OTPs and deploy notifications are ALWAYS TEMP

Subject: ${subject}
Body: ${body}

Return ONLY one label.
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
    const raw =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "SKIP";
    return raw
      .toUpperCase()
      .replace(/\s+/g, "_")
      .replace(/[^A-Z_]/g, "")
      .trim();
  } catch {
    return "SKIP";
  }
}

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
    imap.addBox(folder, true, () => resolve());
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

    msg.once("attributes", (attrs) => {
      uid = attrs.uid;
    });

    msg.on("body", (stream) => {
      simpleParser(stream, (err, result) => {
        if (!err) parsed = result;
      });
    });

    msg.once("end", () => {
      resolve(uid && parsed ? { uid, parsed } : null);
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

// ── Classify command ──────────────────────────────

async function classify() {
  const imap = createImapClient();

  return new Promise((resolve, reject) => {
    imap.once("ready", async () => {
      try {
        await openBox(imap, "INBOX", false);

        const results = await search(imap, ["UNFLAGGED"]);
        if (!results.length) {
          console.log("No unflagged emails to classify.");
          imap.end();
          return resolve();
        }

        console.log(`Found ${results.length} unflagged email(s) to classify.`);
        const messages = await fetchAll(imap, results);

        for (const msg of messages) {
          if (!msg) continue;

          const subject = msg.parsed.subject || "";
          const body = (msg.parsed.text || "").slice(0, 800);
          const label = await classifyEmail(subject, body);

          console.log(`  "${subject}" → ${label}`);

          if (label === "STAR") {
            await addFlags(imap, msg.uid, "\\Flagged");
          } else if (FOLDERS[label]) {
            await ensureFolder(imap, FOLDERS[label]);
            try {
              await moveToFolder(imap, msg.uid, FOLDERS[label]);
            } catch (e) {
              console.error(`  Failed to move: ${e.message}`);
            }
          }
          // SKIP → do nothing, stays in inbox unflagged
        }

        imap.end();
        resolve();
      } catch (e) {
        imap.end();
        reject(e);
      }
    });

    imap.once("error", reject);
    imap.connect();
  });
}

// ── Cleanup command ───────────────────────────────

async function cleanup() {
  const imap = createImapClient();

  return new Promise((resolve, reject) => {
    imap.once("ready", async () => {
      try {
        // Check if Temp folder exists by trying to open it
        try {
          await openBox(imap, "Temp", false);
        } catch {
          console.log("Temp folder does not exist. Nothing to clean up.");
          imap.end();
          return resolve();
        }

        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);

        const results = await search(imap, [["BEFORE", yesterday]]);
        if (!results.length) {
          console.log("No emails older than 24h in Temp.");
          imap.end();
          return resolve();
        }

        console.log(`Deleting ${results.length} email(s) older than 24h from Temp.`);

        await addFlags(imap, results, "\\Deleted");
        await new Promise((resolve, reject) => {
          imap.expunge((err) => (err ? reject(err) : resolve()));
        });

        console.log("Cleanup complete.");
        imap.end();
        resolve();
      } catch (e) {
        imap.end();
        reject(e);
      }
    });

    imap.once("error", reject);
    imap.connect();
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

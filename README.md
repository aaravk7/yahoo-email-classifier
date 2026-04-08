# Yahoo Email Classifier

Automated email classifier for Yahoo Mail using IMAP and Google Gemini AI. Runs on GitHub Actions to classify incoming emails into folders and star actionable ones.

## How It Works

### Classify (every 5 minutes)

Fetches all **unstarred** emails from the inbox and classifies each into one of:

| Outcome | Action |
|---------|--------|
| **Temp** | OTPs, verification codes, CI/deploy notifications |
| **Marketing** | Promotions, newsletters, ads, unsolicited outreach |
| **Jobs** | Job platform emails, recruiter outreach |
| **Finance** | Bank statements, transaction alerts, receipts, invoices |
| **Travel** | Booking confirmations, itineraries, boarding passes |
| **Star** | Actionable emails requiring a response — starred and kept in inbox |
| **Skip** | No category match, not actionable — left in inbox |

### Cleanup (every 6 hours)

Permanently deletes emails in the `Temp` folder that are older than 24 hours.

## Setup

### 1. GitHub Secrets

Add these secrets in your repo under **Settings → Secrets and variables → Actions**:

| Secret | Description |
|--------|-------------|
| `GEMINI_API_KEY` | Google Gemini API key |
| `YAHOO_USER` | Yahoo email address |
| `YAHOO_PASS` | Yahoo app password |

### 2. Yahoo App Password

Yahoo requires an [app password](https://help.yahoo.com/kb/generate-manage-third-party-passwords-sln15241.html) for IMAP access. Generate one in **Yahoo Account Settings → Security → Generate app password**.

## Local Testing

```bash
GEMINI_API_KEY=xxx YAHOO_USER=xxx YAHOO_PASS=xxx node index.js classify
GEMINI_API_KEY=xxx YAHOO_USER=xxx YAHOO_PASS=xxx node index.js cleanup
```

## Tech Stack

- **IMAP** — email access via `node-imap`
- **Gemini 2.5 Flash** — AI classification
- **GitHub Actions** — scheduled execution

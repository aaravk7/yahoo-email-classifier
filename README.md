# Yahoo Email Classifier

Automated email classifier for Yahoo Mail using IMAP and Google Gemini AI. Classifies incoming emails into folders and stars actionable ones.

## How It Works

### Classify

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

### Cleanup

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

## Scheduling

### External scheduler (recommended)

GitHub Actions cron is unreliable — runs can be delayed by minutes or skipped entirely during high load. An external scheduler like [cron-job.org](https://cron-job.org) provides precise timing.

Trigger the workflows via the GitHub API:

```
POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/classifier.yml/dispatches
POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/cleanup.yml/dispatches

Headers:
  Authorization: Bearer <GITHUB_TOKEN>
  Accept: application/vnd.github+json

Body: {"ref": "main"}
```

Recommended schedule:
- **Classify:** every 5 minutes
- **Cleanup:** every 6 hours

### GitHub Actions cron (alternative)

The workflow files include commented-out cron schedules. Uncomment them if you prefer GitHub Actions' built-in scheduling, keeping in mind it may not run on time.

## Local Testing

```bash
GEMINI_API_KEY=xxx YAHOO_USER=xxx YAHOO_PASS=xxx node index.js classify
GEMINI_API_KEY=xxx YAHOO_USER=xxx YAHOO_PASS=xxx node index.js cleanup
```

## Tech Stack

- **IMAP** — email access via `node-imap`
- **Gemini 3.1 Flash Lite** — AI classification
- **GitHub Actions** — execution environment

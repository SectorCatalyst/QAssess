# QAssess systemd Templates

These templates provide a reference supervisor setup for API + workers.

## Files

- `qassess-api.service`: long-running API process (`npm run start`).
- `qassess-pdf-worker.service` + `qassess-pdf-worker.timer`: periodic PDF queue processing.
- `qassess-webhook-worker.service` + `qassess-webhook-worker.timer`: periodic webhook delivery processing.
- `qassess-webhook-replay.service`: on-demand dead-letter replay run.
- `api.env.example`: environment file template.

## Install (Linux/systemd)

From `/Users/troysullivan/Documents/QAssess/apps/api`:

```bash
sudo mkdir -p /etc/qassess
sudo cp deploy/systemd/api.env.example /etc/qassess/api.env
sudo cp deploy/systemd/qassess-*.service /etc/systemd/system/
sudo cp deploy/systemd/qassess-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qassess-api.service
sudo systemctl enable --now qassess-pdf-worker.timer
sudo systemctl enable --now qassess-webhook-worker.timer
```

## Validate

```bash
sudo systemctl status qassess-api.service --no-pager
sudo systemctl status qassess-pdf-worker.timer --no-pager
sudo systemctl status qassess-webhook-worker.timer --no-pager
sudo journalctl -u qassess-api.service -u qassess-pdf-worker.service -u qassess-webhook-worker.service -n 200 --no-pager
```

On-demand dead-letter replay:

```bash
sudo systemctl start qassess-webhook-replay.service
sudo journalctl -u qassess-webhook-replay.service -n 50 --no-pager
```

## Polling Guidance

- Start with:
  - PDF timer: every `1 minute`.
  - Webhook timer: every `30 seconds`.
- Tune with env:
  - `PDF_WORKER_BATCH_SIZE`
  - `WEBHOOK_WORKER_BATCH_SIZE`
  - `WEBHOOK_WORKER_MAX_ATTEMPTS`
  - `WEBHOOK_REPLAY_LIMIT`
  - `LOG_SINK_URL` / `LOG_SINK_TOKEN` (optional centralized log forwarding)
- Increase timer frequency only after verifying DB headroom and queue lag.

Queue/retry health snapshot:

```bash
cd /Users/troysullivan/Documents/QAssess/apps/api
npm run ops:metrics:snapshot -- --assert-thresholds
```

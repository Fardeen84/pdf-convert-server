# Mrig Convert Server

NestJS API that powers the conversions in the Mrig PDF app.

| From | To | Engine | Quality |
|---|---|---|---|
| doc, docx, odt, rtf, txt | PDF | LibreOffice | very good |
| xls, xlsx, ods, csv | PDF | LibreOffice | very good |
| ppt, pptx, odp | PDF | LibreOffice | very good |
| PDF | DOCX | pdf2docx | good for text PDFs; scanned PDFs come back near-empty (`X-Convert-Note: scanned_no_text`) |
| PDF | XLSX | PyMuPDF table finder | good for PDFs with ruled tables; otherwise one sheet per page of text (`no_tables_text_fallback`) |
| PDF | PPTX | PyMuPDF render | one image per slide (looks identical, not editable); page text goes into speaker notes |

Files are processed in a temp folder and deleted as soon as the response is sent. Nothing is logged except timings and error text.

## API

`POST /convert/:target` — multipart form, field `file` (+ optional `password` for locked PDFs).
`target` = `pdf | docx | xlsx | pptx`. Header `x-api-key: <API_KEY>`.

Errors: 400 wrong type/target · 401 bad key · 413 too big · 422 could not convert (message is user-safe) · 429 rate limit.

`GET /health`, `GET /formats` — no key needed.

## Run

```bash
cp .env.example .env     # set API_KEY
docker compose up -d --build
curl -H "x-api-key: $API_KEY" -F file=@report.docx localhost:3000/convert/pdf -o report.pdf
```

Local without Docker: needs Node 22, LibreOffice and Python 3 with `pip install -r python/requirements.txt`, then `npm i && npm run build && npm start`.

Tests: `npm run build && npm run test:e2e` (needs soffice + the python packages locally).

## Deploy notes

- Put HTTPS in front (Caddy/nginx). The app must not call plain `http://` in release builds.
- A 2 vCPU / 4 GB VPS handles `MAX_JOBS=2` comfortably. Raise `MAX_JOBS` only with more RAM.
- `API_KEY` inside a mobile app can be extracted; it only deters casual abuse. Rate limit (`RATE_LIMIT_PER_MIN`, per IP) and `MAX_FILE_MB` are the real protection. If abuse shows up, add per-install tokens (e.g. Play Integrity).
- Fonts: Noto (incl. Devanagari) and Liberation are installed so Hindi documents and Arial/Times/Calibri-metric layouts render correctly. Add any custom fonts your customers use under `/usr/local/share/fonts`.

## Render (free plan)

1. Push this folder to a GitHub repo (`.env` and `node_modules` are git-ignored via `.gitignore`).
2. Render dashboard > New > Blueprint > select the repo (it reads `render.yaml`). First build takes ~10 min.
3. When live, open the service > Environment, copy `API_KEY`. Your URL looks like `https://mrig-convert.onrender.com`.
4. Check: `curl https://<your-url>/health`
5. Build the app with `--dart-define=CONVERT_URL=https://<your-url> --dart-define=CONVERT_KEY=<API_KEY> --dart-define=CONVERT_MAX_MB=10`.

Free plan limits: 512 MB RAM, spins down after 15 min idle (first request after that waits ~1 min), 750 instance-hours/month.

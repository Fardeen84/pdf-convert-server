#!/usr/bin/env bash
# End-to-end check against a locally running server (builds fixtures with LibreOffice).
# Usage: npm run build && bash test/e2e.sh
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-3999}
export PORT API_KEY=testkey MAX_FILE_MB=5 RATE_LIMIT_PER_MIN=1000
W=$(mktemp -d); trap 'kill $SRV 2>/dev/null; rm -rf "$W"' EXIT
fail=0; ok(){ echo "PASS  $1"; }; bad(){ echo "FAIL  $1"; fail=1; }

# fixtures
cat > "$W/doc.html" <<'H'
<html><body><h1>Mrig Test</h1><p>Hello नमस्ते world.</p>
<table border="1"><tr><th>Item</th><th>Qty</th><th>Price</th></tr>
<tr><td>Pen</td><td>10</td><td>5.5</td></tr><tr><td>Book</td><td>3</td><td>120</td></tr>
<tr><td>Bag</td><td>1</td><td>999</td></tr></table></body></html>
H
printf 'name,score\nA,1\nB,2\n' > "$W/data.csv"
printf 'plain text file\n' > "$W/note.txt"
lo(){ timeout 90 soffice -env:UserInstallation=file://$W/lo --headless --norestore --convert-to "$@" >/dev/null 2>&1; }
( cd "$W" && lo 'docx:MS Word 2007 XML' doc.html && lo xlsx data.csv && lo pdf doc.docx )
[ -f "$W/doc.pdf" ] && ok "fixtures built" || { bad "fixtures"; exit 1; }

node dist/main.js > "$W/server.log" 2>&1 & SRV=$!
for i in $(seq 1 30); do curl -sf localhost:$PORT/health >/dev/null && break; sleep 0.5; done
curl -sf localhost:$PORT/health >/dev/null && ok "server up" || { bad "server up"; cat "$W/server.log"; exit 1; }

H="x-api-key: testkey"
post(){ curl -s -o "$W/out.$3" -w '%{http_code}' -H "$H" -F "file=@$1" ${4:+-F "password=$4"} localhost:$PORT/convert/$2; }

[ "$(curl -s -o /dev/null -w '%{http_code}' -F file=@$W/doc.docx localhost:$PORT/convert/pdf)" = 401 ] && ok "401 without key" || bad "401 without key"
for f in doc.docx data.xlsx data.csv note.txt; do
  c=$(post "$W/$f" pdf pdf); head -c4 "$W/out.pdf" | grep -q '%PDF' && [ "$c" = 200 ] && ok "$f -> pdf" || bad "$f -> pdf ($c)"
done
c=$(post "$W/doc.pdf" docx docx); python3 -c "
import zipfile,re,sys
z=zipfile.ZipFile('$W/out.docx'); x=z.read('word/document.xml').decode()
sys.exit(0 if 'Mrig Test' in x and 'Pen' in x else 1)" && [ "$c" = 200 ] && ok "pdf -> docx (text kept)" || bad "pdf -> docx ($c)"
c=$(post "$W/doc.pdf" xlsx xlsx); python3 -c "
import openpyxl,sys
wb=openpyxl.load_workbook('$W/out.xlsx'); print('   sheets:',wb.sheetnames)
vals=[c.value for ws in wb for r in ws.iter_rows() for c in r]
sys.exit(0 if 'Pen' in vals or any('Pen' in str(v) for v in vals) else 1)" && [ "$c" = 200 ] && ok "pdf -> xlsx (table found)" || bad "pdf -> xlsx ($c)"
c=$(post "$W/doc.pdf" pptx pptx); python3 -c "
from pptx import Presentation; import sys
p=Presentation('$W/out.pptx'); sys.exit(0 if len(p.slides)>=1 else 1)" && [ "$c" = 200 ] && ok "pdf -> pptx" || bad "pdf -> pptx ($c)"

# negative cases
[ "$(post "$W/doc.pdf" pdf pdf)" = 400 ] && ok "pdf -> pdf rejected (400)" || bad "pdf->pdf should be 400"
[ "$(post "$W/doc.docx" docx docx)" = 400 ] && ok "docx -> docx rejected (400)" || bad "docx->docx should be 400"
[ "$(post "$W/doc.pdf" exe exe)" = 400 ] && ok "unknown target 400" || bad "unknown target"
head -c 6000000 /dev/urandom > "$W/big.pdf"
[ "$(post "$W/big.pdf" docx docx)" = 413 ] && ok "oversize -> 413" || bad "oversize should be 413"
echo "not a pdf" > "$W/fake.pdf"
c=$(post "$W/fake.pdf" docx docx); [ "$c" = 422 ] && ok "corrupt pdf -> 422" || bad "corrupt pdf ($c)"
python3 - <<P
import pymupdf
d=pymupdf.open('$W/doc.pdf'); d.save('$W/locked.pdf',encryption=pymupdf.PDF_ENCRYPT_AES_256,user_pw='secret',owner_pw='o'); 
P
[ "$(post "$W/locked.pdf" docx docx)" = 422 ] && ok "locked pdf w/o password -> 422" || bad "locked w/o pw"
[ "$(post "$W/locked.pdf" docx docx secret)" = 200 ] && ok "locked pdf with password -> 200" || bad "locked with pw"
# concurrency: 4 parallel office jobs with MAX_JOBS=2 must all succeed
pids=""; for i in 1 2 3 4; do (post "$W/doc.docx" pdf p$i > "$W/c$i") & pids="$pids $!"; done; wait $pids
[ "$(cat $W/c1 $W/c2 $W/c3 $W/c4 | tr -d '\n')" = 200200200200 ] && ok "4 parallel jobs" || bad "parallel: $(cat $W/c1 $W/c2 $W/c3 $W/c4 | tr '\n' ' ')"
sleep 1; n=$(ls -d /tmp/mrigconv-* /tmp/upload-* 2>/dev/null | wc -l); [ "$n" = 0 ] && ok "no temp files left" || bad "$n temp leftovers"
[ $fail = 0 ] && echo "ALL PASSED" || echo "SOME FAILED"; exit $fail

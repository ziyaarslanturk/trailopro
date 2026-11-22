#!/usr/bin/env bash
# data/ ve state/ degisikliklerini commit'ler ve gonderir.
# Uzak dalda ayni dosyalar degismisse (cakisma) bizim sonucumuz ESKI tabana dayaniyor demektir:
# onu atariz, GITHUB_OUTPUT'a yayinlandi=false yazariz ve basariyla cikariz. Is sonraki turda taze veriyle yeniden yapilir.
# yayinlandi=true  -> veri uzak depoda (Firebase kayitlari guvenle silinebilir)
# yayinlandi=false -> veri yayinlanmadi (Firebase'e DOKUNMA)
set -u
ULKE="${1:-}"
DAL="${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)}"
cikti() { [ -n "${GITHUB_OUTPUT:-}" ] && echo "yayinlandi=$1" >> "$GITHUB_OUTPUT"; return 0; }

git config user.name "trailopro-bot"
git config user.email "trailopro-bot@users.noreply.github.com"
git add -A data state
if git diff --cached --quiet; then echo "Degisiklik yok."; cikti true; exit 0; fi
git commit -q -m "dongu: ${ULKE:-genel} guncellendi [skip ci]"

gecerli_mi() {  # birlesen JSON dosyalari bozulmadi mi?
  python3 - <<'PY'
import glob, json, sys
for f in glob.glob("data/*.json") + glob.glob("state/*.json"):
    try:
        json.load(open(f, encoding="utf-8"))
    except Exception as e:
        print("bozuk JSON:", f, e); sys.exit(1)
PY
}

for i in 1 2 3 4 5; do
  if git push -q origin "HEAD:$DAL" 2>/dev/null; then echo "push tamam (deneme $i)"; cikti true; exit 0; fi
  git fetch -q origin "$DAL" || { sleep $((i * 10)); continue; }
  if git rebase -q "origin/$DAL" 2>/dev/null && gecerli_mi; then
    continue   # temiz birlesti; tekrar push dene
  fi
  echo "Cakisma: uzak depoda ayni dosyalar degismis. Bu turun sonucu atiliyor (sonraki tur taze veriyle yapacak)."
  git rebase --abort 2>/dev/null || true
  git reset -q --hard "origin/$DAL"
  cikti false
  exit 0
done
echo "::warning::push 5 denemede basarisiz; sonuc yayinlanmadi, Firebase kayitlari silinmeyecek."
git reset -q --hard "origin/$DAL" 2>/dev/null || true
cikti false
exit 0

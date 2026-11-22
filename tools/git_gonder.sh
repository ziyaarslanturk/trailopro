#!/usr/bin/env bash
# data/ ve state/ degisikliklerini commit'ler, cakisma/yaris durumunda tekrar dener.
set -u
ULKE="${1:-}"
git config user.name "trailopro-bot"
git config user.email "trailopro-bot@users.noreply.github.com"
git add -A data state
if git diff --cached --quiet; then echo "Degisiklik yok."; exit 0; fi
git commit -q -m "dongu: ${ULKE:-genel} guncellendi [skip ci]"
DAL="${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)}"
for i in 1 2 3 4 5 6 7 8; do
  if git pull --rebase -q origin "$DAL"; then
    if git push -q origin "HEAD:$DAL"; then echo "push tamam (deneme $i)"; exit 0; fi
  else
    git rebase --abort 2>/dev/null || true
  fi
  echo "push basarisiz, ${i}. deneme; bekleniyor..."
  sleep $((i * 15))
done
echo "::error::push basarisiz; Firebase kayitlari SILINMEDI, sonraki turda tekrar islenecek"
exit 1

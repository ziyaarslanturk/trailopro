name: Camp Data Fetch

on:
  workflow_dispatch:
  schedule:
    - cron: '0 2 * * *'

jobs:
  fetch:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        country: [
          TR, DE, FR, IT, ES, AT, CH, NL, BE, GR, HR, PT, NO, SE, 
          GCC, JO, EG, MA, RU, 
          US_WEST, US_SOUTH, US_MIDWEST, US_NORTHEAST, US_PACIFIC,
          OM, CZ, IE, BH, AE, GB, DZ, DK, FI, QA, KW, LU, PL, SA, TN
        ]
        
    steps:
      - name: Depoyu Çek (Checkout)
        uses: actions/checkout@v3

      - name: Python Kurulumu
        uses: actions/setup-python@v4
        with:
          python-version: '3.10'

      - name: Gerekli Kütüphaneleri Yükle
        run: pip install PyGithub requests

      - name: ${{ matrix.country }} Verisini İndir ve İşle
        run: python camp_fetch.py ${{ matrix.country }}

  commit:
    needs: fetch
    runs-on: ubuntu-latest
    steps:
      - name: Depoyu Çek (Checkout)
        uses: actions/checkout@v3

      - name: Değişiklikleri GitHub'a Gönder
        run: |
          git config --global user.email "actions@github.com"
          git config --global user.name "GitHub Actions"
          git add data/*.json
          if git status --porcelain | grep .; then
            git commit -m "Kamp alanlari guncellendi"
            git push
          else
            echo "Herhangi bir degisiklik bulunamadi."
          fi

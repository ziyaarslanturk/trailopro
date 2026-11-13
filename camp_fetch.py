name: Camp Data Fetch

on:
  workflow_dispatch:
  schedule:
    - cron: '0 2 * * *'

jobs:
  fetch-and-commit:
    runs-on: ubuntu-latest
    
    steps:
      - name: Depoyu Çek (Checkout)
        uses: actions/checkout@v3

      - name: Osmium Aracını Yükle (Eksik olan buydu)
        run: sudo apt-get update && sudo apt-get install -y osmium-tool

      - name: Python Kurulumu
        uses: actions/setup-python@v4
        with:
          python-version: '3.10'

      - name: Gerekli Kütüphaneleri Yükle
        run: pip install requests

      - name: Tüm Verileri İndir, İşle ve Pushla
        run: python camp_fetch.py

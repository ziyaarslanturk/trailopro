name: Camp Data Fetch

on:
  workflow_dispatch:
    inputs:
      countries:
        description: "Ulke kodlari, virgulle ayirin (ornek: DE,IT,RU)"
        required: true
        default: "DE,IT,RU"

permissions:
  contents: write

jobs:
  prepare:
    runs-on: ubuntu-latest
    outputs:
      list: ${{ steps.m.outputs.list }}
    steps:
      - id: m
        run: |
          list=$(echo "${{ inputs.countries }}" | tr -d ' ' | jq -R -c 'split(",")')
          echo "list=$list" >> "$GITHUB_OUTPUT"

  fetch:
    needs: prepare
    runs-on: ubuntu-latest
    timeout-minutes: 120
    strategy:
      fail-fast: false
      max-parallel: 3
      matrix:
        code: ${{ fromJSON(needs.prepare.outputs.list) }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: Bagimliliklar
        run: |
          sudo apt-get update
          sudo apt-get install -y osmium-tool
          pip install requests

      - name: Veriyi cek
        run: python camp_fetch.py ${{ matrix.code }}

      - uses: actions/upload-artifact@v4
        with:
          name: camp-${{ matrix.code }}
          path: out/${{ matrix.code }}.json
          retention-days: 7

  commit:
    needs: fetch
    if: always()
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/download-artifact@v4
        with:
          pattern: camp-*
          path: data
          merge-multiple: true

      - name: Depoya commit et
        run: |
          git config user.name "github-actions"
          git config user.email "actions@github.com"
          git add data/
          git diff --cached --quiet || git commit -m "Update camp data"
          git pull --rebase
          git push

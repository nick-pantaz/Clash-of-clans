# Clash Rush Tracker

A phone-friendly web app (PWA) for tracking a Clash of Clans rush from **Town Hall 10 to 18**. It uses the minimum-upgrade list from `data/source/coc_th10_to_th18_rush.xlsx`.

- **Next**: what still blocks your next Town Hall, plus the best jobs for any free builders right now.
- **Spare builder upgrades**: later-stage upgrades that are already unlocked, longest chains first (for example cannons and archer towers climbing to level 21 for the merges), so they don't hold you up later.
- **Builders**: one card per builder, each with a live countdown. Start a job here when you start it in the game, and collect it when it finishes. "Set time left" lets you match the in-game timer after boosts.
- **Progress**: % done, gold, elixir and dark elixir left, progress per stage, and an estimated finish.
- **All**: every upgrade, with search and filters. Tick things you already have (ticking a level also ticks the levels before it). "Skip" leaves an item out of the plan.
- **Settings** (gear icon): number of builders (1–6), set your starting Town Hall in one tap, theme, and export/import a backup.

Progress is stored on your device (`localStorage`). Use Export/Import to move it to another phone.

## Deploy on Netlify

1. In Netlify, choose **Add new site → Import an existing project** and pick this repo.
2. Leave the build command empty. The publish directory is `.` (already set in `netlify.toml`).
3. Deploy.

## Install on your phone

- **iPhone**: open the site in Safari, tap **Share → Add to Home Screen**.
- **Android**: open the site in Chrome, tap **⋮ → Install app** (or **Add to Home screen**).

After the first visit, the app works offline.

## Updating the data

Edit the spreadsheet in `data/source/`, then regenerate the JSON:

```sh
python3 scripts/extract_data.py
```

The script uses only the Python standard library. It also works out which upgrades must come first: previous levels, the buildings each merge needs, and everything a Town Hall upgrade requires. After changing any app file, bump `CACHE` in `sw.js` so installed copies pick up the update.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

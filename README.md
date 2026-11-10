# Beerdome-bewaking

Controleert elke 10 minuten of beerdome.nl werkt:

1. homepage laadt;
2. een product kan in de winkelwagen (winkel-API) en er zijn betaalmethodes;
3. de afrekenpagina laadt met een gevulde winkelwagen.

Mislukt iets twee keer achter elkaar (met een minuut ertussen), dan komt er een pushmelding via
[ntfy](https://ntfy.sh). Bij een storing die langer duurt komt er elke 2 uur een herinnering, en
een melding zodra alles weer werkt. Elke maandagochtend komt er een kort "bewaking leeft".

## Wie controleert

- **Hoofd = mini-pc thuis** (`--rol hoofd`, Taakplanner "Beerdome bewaking" via `minipc/bewaking.ps1`).
  Thuis-IP, dus geen SiteGround-botcontrole. Is het eigen internet weg, dan is dat geen storing.
- **Reserve = GitHub Actions** (`--rol reserve`, gestart door cron-job.org en GitHub-cron). Kijkt eerst
  naar de hartslag van de mini-pc; alleen als die 45 min stil is controleert GitHub zelf (en meldt één keer
  "mini-pc controleert niet"). Zo komen er geen dubbele meldingen.
- Hartslag = apart ntfy-topic `<topic>-hartslag` (niet abonneren op de telefoon).
- **"Bewaking is blind"**: lukt er 3 uur nergens een echte controle (botcontrole, mini-pc en GitHub stil),
  dan komt er een melding. De mini-pc meldt het ook als GitHub (reserve) 8 uur niets laat horen.

## Testen

`node check.mjs --rol hoofd --droog` (geen meldingen). Nabootsen: `SITE=https://www.beerdome.invalid`
(storing), `NABOOTSEN=botcontrole` (+ `BLIND_UUR=0.001`), `NABOOTSEN=geen-internet`, `WACHT_MS=1000`.
Gebruik voor echte tests een eigen testtopic in `NTFY_TOPIC` en een aparte `STATE=`.

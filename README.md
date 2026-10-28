# Beerdome-bewaking

Controleert elke 10 minuten via GitHub Actions of beerdome.nl werkt:

1. homepage laadt;
2. een product kan in de winkelwagen (winkel-API) en er zijn betaalmethodes;
3. de afrekenpagina laadt met een gevulde winkelwagen.

Mislukt iets twee keer achter elkaar (met een minuut ertussen), dan komt er een pushmelding via
[ntfy](https://ntfy.sh). Bij een storing die langer duurt komt er elke 2 uur een herinnering, en
een melding zodra alles weer werkt. Elke maandagochtend komt er een kort "bewaking leeft".

- Topicnaam staat als secret `NTFY_TOPIC` (niet in de code).
- Lokaal testen zonder melding: `node check.mjs --droog`.
- Handmatig starten: tab Actions > Bewaking > Run workflow.

# Tuiss SmartView voor Homey Pro

Homey Pro-app (SDK v3) die Tuiss SmartView elektrische plissés en raamdecoratie
(ook verkocht via Blinds2go) **rechtstreeks via Bluetooth Low Energy** bedient.
Er is geen Tuiss-hub of cloud nodig.

Het BLE-protocol is overgenomen uit de Home Assistant-integratie
[Tuiss2HA](https://github.com/pink88/Tuiss2HA) van pink88.

## Functies

| Functie | Hoe |
|---|---|
| Openen / sluiten / stoppen | Standaard Homey-knoppen en Flow-kaarten (`windowcoverings_state`) |
| Positie instellen (0–100%) | Schuifregelaar en Flow-kaart (`windowcoverings_set`) |
| Positie live volgen tijdens bewegen | Via notificaties van de motor |
| Ander doel kiezen of stoppen tijdens bewegen | Gaat via de al open verbinding, dus direct |
| Batterij laag-melding | `alarm_battery` (Tuiss geeft alleen goed/laag door, geen percentage) |
| Motorsnelheid (Standaard / Comfort / Langzaam) | Apparaatinstelling + Flow-kaart (alleen TS5200, TS5101, TS5001, TS2600) |
| Favoriete positie | Instelling + Flow-kaart "Ga naar favoriete positie" |
| Positie uitlezen (na gebruik van de afstandsbediening) | Flow-kaart, of periodiek via instelling |
| Richting omkeren | Instelling, voor als open/dicht bij jouw plissé andersom staat |
| Automatisch opnieuw proberen | Instelbaar aantal verbindingspogingen |

## Installeren

Je hebt een computer met [Node.js](https://nodejs.org) nodig.

```bash
npm install -g homey     # Homey CLI, eenmalig
homey login              # log in met je Athom-account
git clone https://github.com/mierpost/com.tuiss.git
cd com.tuiss
homey app install        # installeert de app blijvend op je Homey Pro
```

Om eerst te testen met live logs, zonder hem blijvend te installeren:
`homey app run`.

## Plissé toevoegen

1. Homey-app → **Apparaat toevoegen** → **Tuiss SmartView**.
2. Maak de plissé wakker (druk een knop in op de afstandsbediening of motor).
3. Kies hem uit de lijst. Herkende motoren adverteren als `TS3000`, `TS5200`,
   `TS5001`, `TS5101`, `TS5300`, `TS2600` of `TS2900`.
   Staat hij er niet tussen? Vink dan **Toon alle Bluetooth-apparaten** aan, of
   vul het **MAC-adres** in (te vinden op het label van de motor of in de
   Tuiss SmartView-app).

**Eerste test:** gebruik eerst de Flow-kaart *Controleer batterij* of
*Lees positie uit*. Werkt dat, dan kloppen de verbinding en het protocol.
Zet de plissé daarna op bijv. 50% en controleer of de richting klopt. Zo
niet, zet dan **Richting omkeren** aan.

## Goed om te weten

- **Bereik:** alleen zo ver als het Bluetooth-signaal van de Homey Pro zelf
  reikt. Bij een zwak signaal (zie *Informatie → Signaalsterkte* in de
  apparaatinstellingen; lager dan ongeveer −85 dBm wordt lastig) helpt het
  om de Homey dichterbij te zetten of het aantal verbindingspogingen te verhogen.
- **Eén verbinding per commando:** net als Tuiss2HA verbindt de app per
  opdracht en verbreekt de verbinding weer zodra de plissé stilstaat.
  Daardoor reageert hij 1 tot 3 seconden later dan de afstandsbediening. Dat is normaal.
- **Afstandsbediening / Tuiss-app:** Homey ziet het niet vanzelf als de
  plissé op een andere manier bewogen is. Gebruik de Flow-kaart *Lees positie
  uit* of zet *Positie uitlezen elke … min* aan. Dat kost wel batterij, dus
  kies liever een ruime interval (bijv. 60 minuten) of laat het uit.
- **Limieten en timers in de motor** stel je in met de Tuiss SmartView-app.
  In Homey gebruik je daarvoor gewoon Flows.

## Ontwikkelen

```
lib/protocol.js           BLE-UUID's, commando's en parsers (uit Tuiss2HA)
lib/TuissSession.js       één BLE-verbinding: connect, notificaties, request/response
drivers/blind/device.js   bewegen, stoppen, batterij, snelheid, polling, retries
drivers/blind/driver.js   koppelen (scan + handmatig MAC) en Flow-kaarten
drivers/blind/pair/       koppelscherm
test/                     unit- en simulatietests (nep-Homey + gesimuleerde motor)
```

```bash
npm test                          # tests draaien
homey app validate --level publish
```

`app.json` wordt door de Homey CLI gegenereerd uit `.homeycompose/` en
`drivers/*/driver.*.compose.json`. Pas die bronbestanden aan, niet `app.json` zelf.

**Protocolnotitie:** de ruwe positiewaarde van de motor is 0 = dicht en
100 = open, net als in Homey. Tuiss2HA noemt dit "omgekeerd", maar keert het
onderweg twee keer om, dus netto verandert er niets. Dat is in
`test/protocol.test.js` vastgelegd.

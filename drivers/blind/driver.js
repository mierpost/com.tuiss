'use strict';

const Homey = require('homey');
const { isTuissName, normalizeMac } = require('../../lib/protocol');

class TuissBlindDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow.getActionCard('set_speed')
      .registerRunListener(({ device, speed }) => device.setSpeed(speed));
    this.homey.flow.getActionCard('go_to_favorite')
      .registerRunListener(({ device }) => device.goToFavorite());
    this.homey.flow.getActionCard('refresh_position')
      .registerRunListener(({ device }) => device.refreshPosition());
    this.homey.flow.getActionCard('check_battery')
      .registerRunListener(({ device }) => device.checkBattery());
  }

  async onPair(session) {
    session.setHandler('scan', async () => this._scan());

    session.setHandler('manual', async ({ mac, name }) => {
      const address = normalizeMac(mac);
      if (!address) throw new Error(this.homey.__('pair.invalid_mac'));
      const existing = this.getDevices().find((d) => d.getData().id === address);
      if (existing) throw new Error(this.homey.__('pair.already_added'));
      return {
        name: String(name || '').trim() || `Tuiss ${address.slice(-5)}`,
        data: { id: address, address },
        store: { uuid: address.replace(/:/g, '').toLowerCase() },
      };
    });
  }

  async _scan() {
    const advertisements = await this.homey.ble.discover();
    const paired = new Set(this.getDevices().map((d) => d.getData().id));
    const seen = new Set();
    const results = [];

    for (const adv of advertisements) {
      const address = normalizeMac(adv.address) || normalizeMac(adv.uuid);
      if (!address || seen.has(address)) continue;
      seen.add(address);
      results.push({
        name: adv.localName ? `${adv.localName} (${address.slice(-5)})` : address,
        likely: isTuissName(adv.localName),
        paired: paired.has(address),
        rssi: adv.rssi,
        device: {
          name: adv.localName ? `Tuiss ${adv.localName} ${address.slice(-5)}` : `Tuiss ${address.slice(-5)}`,
          data: { id: address, address },
          store: { uuid: adv.uuid, model: adv.localName || null },
        },
      });
    }

    results.sort((a, b) => (b.likely - a.likely) || ((b.rssi || -999) - (a.rssi || -999)));
    return results;
  }

}

module.exports = TuissBlindDriver;

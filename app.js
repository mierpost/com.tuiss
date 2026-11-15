'use strict';

const Homey = require('homey');

class TuissApp extends Homey.App {

  async onInit() {
    this.log('Tuiss SmartView app started');
  }

}

module.exports = TuissApp;

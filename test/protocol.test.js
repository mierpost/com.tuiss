'use strict';

const test = require('node:test');
const assert = require('node:assert');
const p = require('../lib/protocol');

const hex = (buf) => buf.toString('hex');

test('set position: raw scale matches Tuiss2HA end-to-end (100 = open)', () => {
  // Tuiss2HA: set_cover_position(pos) -> hex_convert(100 - pos) -> total = round((100 - (100 - pos)) * 10)
  assert.strictEqual(hex(p.buildSetPositionCommand(100)), 'ff78ea41bf03e803'); // open, 1000 = 0x03e8
  assert.strictEqual(hex(p.buildSetPositionCommand(0)), 'ff78ea41bf030000'); // closed
  assert.strictEqual(hex(p.buildSetPositionCommand(73)), 'ff78ea41bf03da02'); // 730 = 0x02da
  assert.strictEqual(hex(p.buildSetPositionCommand(25.5)), 'ff78ea41bf03ff00'); // 255
});

test('set position clamps out-of-range values', () => {
  assert.strictEqual(hex(p.buildSetPositionCommand(120)), 'ff78ea41bf03e803');
  assert.strictEqual(hex(p.buildSetPositionCommand(-5)), 'ff78ea41bf030000');
});

test('timestamp command', () => {
  const d = new Date(2026, 10, 15, 13, 37, 5); // 15 Nov 2026 13:37:05 local
  assert.strictEqual(hex(p.buildTimestampCommand(d)), 'ff78ea4102001a0b0f0d2505');
});

test('battery parsing (hub.py battery_callback)', () => {
  assert.strictEqual(p.parseBatteryResponse(Buffer.from([0xff, 0x78, 0xea, 0x41, 0xd2, 0x02, 0x00])), 'good');
  assert.strictEqual(p.parseBatteryResponse(Buffer.from([0xff, 0x78, 0xea, 0x41, 0xd2, 0x0a, 0x00])), 'low');
  assert.strictEqual(p.parseBatteryResponse(Buffer.from([0xff, 0x78, 0xea, 0x41, 0xd2])), 'low');
  assert.strictEqual(p.parseBatteryResponse(Buffer.from([0xff, 0x78, 0xea, 0x41, 0xd1, 0x02])), null);
});

test('position parsing (hub.py position_callback)', () => {
  // (b7 + 256 * b8) / 10 = (0xda + 0x200) / 10 = 73
  assert.strictEqual(p.parsePositionResponse(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0xda, 0x02])), 73);
  assert.strictEqual(p.parsePositionResponse(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0xda])), null);
});

test('movement parsing (hub.py set_position_callback)', () => {
  assert.strictEqual(p.parseMovementResponse(Buffer.from([0, 0, 0, 0, 0xd2, 0, 42, 0, 0])), 42);
  assert.strictEqual(p.parseMovementResponse(Buffer.from([0, 0, 0, 0, 0xd1, 0, 42, 0, 0])), null);
  assert.strictEqual(p.parseMovementResponse(Buffer.from([0, 0, 0, 0, 0xd2, 0, 42])), null);
});

test('helpers', () => {
  assert.strictEqual(p.normalizeMac('aa-bb-cc-dd-ee-ff'), 'AA:BB:CC:DD:EE:FF');
  assert.strictEqual(p.normalizeMac('aabbccddeeff'), 'AA:BB:CC:DD:EE:FF');
  assert.strictEqual(p.normalizeMac('nope'), null);
  assert.strictEqual(p.normalizeUuid('00010405-0405-0607-0809-0A0B0C0D1910'), '000104050405060708090a0b0c0d1910');
  assert.ok(p.isTuissName('TS5200'));
  assert.ok(p.isTuissName('ts3000-ab12'));
  assert.ok(!p.isTuissName('Mi Band'));
  assert.ok(p.supportsSpeed('TS2600'));
  assert.ok(!p.supportsSpeed('TS3000'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typeById, withScheme, icsDate, estimateModules, printCheck } from '../public/js/content.js';

const build = (id, v) => typeById(id).build(v);

test('url adds https and validates', () => {
  assert.equal(build('url', { url: 'example.com/a' }), 'https://example.com/a');
  assert.equal(build('url', { url: '  ' }), '');
  assert.equal(withScheme('http://x.io'), 'http://x.io');
  assert.match(typeById('url').check({ url: 'javascript:alert(1)' }), /http/);
  assert.equal(typeById('url').check({ url: 'example.com' }), '');
});

test('wifi escapes special characters and handles open networks', () => {
  assert.equal(build('wifi', { ssid: 'My;Net', pass: 'p:a"ss', enc: 'WPA' }), 'WIFI:T:WPA;S:My\\;Net;P:p\\:a\\"ss;;');
  assert.equal(build('wifi', { ssid: 'Cafe', enc: 'nopass' }), 'WIFI:T:nopass;S:Cafe;;');
  assert.equal(build('wifi', { ssid: 'H', pass: 'x', enc: 'WPA', hidden: 'Yes' }), 'WIFI:T:WPA;S:H;P:x;H:true;;');
  assert.equal(build('wifi', { ssid: '' }), '');
});

test('vcard builds a valid card and escapes values', () => {
  const v = build('vcard', { first: 'Asha', last: 'Rao', org: 'Acme, Inc.', tel: '+91 98765-43210', email: 'a@x.in', url: 'acme.in' });
  assert.match(v, /^BEGIN:VCARD\nVERSION:3\.0\nN:Rao;Asha;;;\nFN:Asha Rao\nORG:Acme\\, Inc\.\n/);
  assert.match(v, /TEL;TYPE=CELL:\+919876543210/);
  assert.match(v, /URL:https:\/\/acme\.in\nEND:VCARD$/);
  assert.equal(build('vcard', {}), '');
});

test('location validates ranges', () => {
  assert.equal(build('location', { lat: '28.6139', lng: '77.2090' }), 'geo:28.6139,77.209');
  assert.equal(build('location', { lat: '91', lng: '0' }), '');
  assert.match(typeById('location').check({ lat: '91', lng: '0' }), /Latitude/);
  assert.equal(build('location', { lat: 'abc', lng: '1' }), '');
});

test('event builds an iCalendar block', () => {
  assert.equal(icsDate('2026-03-14T18:30'), '20260314T183000');
  const e = build('event', { title: 'Launch, party', start: '2026-03-14T18:30', end: '2026-03-14T20:00', place: 'HQ' });
  assert.match(e, /SUMMARY:Launch\\, party/);
  assert.match(e, /DTSTART:20260314T183000/);
  assert.match(e, /DTEND:20260314T200000/);
  assert.equal(build('event', { title: 'x' }), '');
  assert.match(typeById('event').check({ start: '2026-03-14T18:30', end: '2026-03-14T10:00' }), /before/);
});

test('whatsapp, social and sms', () => {
  assert.equal(build('whatsapp', { num: '+91 98765 43210', msg: 'Hi there' }), 'https://wa.me/919876543210?text=Hi%20there');
  assert.equal(build('whatsapp', { num: '123' }), '');
  assert.equal(build('social', { platform: 'instagram', handle: '@qrforge' }), 'https://instagram.com/qrforge');
  assert.equal(build('social', { platform: 'youtube', handle: 'qrforge' }), 'https://youtube.com/@qrforge');
  assert.equal(build('social', { platform: 'x', handle: 'bad handle!' }), '');
  assert.equal(build('sms', { num: '+1 (555) 123-4567', msg: 'hello' }), 'SMSTO:+15551234567:hello');
});

test('upi builds a payment link and rejects bad input', () => {
  assert.equal(build('upi', { pa: 'shop@okbank', pn: 'Chai Shop', am: '49.50', tn: 'Order 12' }),
    'upi://pay?pa=shop%40okbank&pn=Chai%20Shop&am=49.50&cu=INR&tn=Order%2012');
  assert.equal(build('upi', { pa: 'notupi', pn: 'X' }), '');
  assert.equal(build('upi', { pa: 'a.b@bank', pn: 'X', am: '12abc' }), '');
  assert.match(typeById('upi').check({ pa: 'nope' }), /UPI ID/);
});

test('email, phone', () => {
  assert.equal(build('email', { to: 'a@b.co', subject: 'Hi there', body: 'x&y' }), 'mailto:a@b.co?subject=Hi%20there&body=x%26y');
  assert.equal(build('phone', { tel: '+91 98765-43210' }), 'tel:+919876543210');
});

test('print check estimates modules and flags small prints', () => {
  assert.equal(estimateModules('https://example.com'), 29);   // 19 bytes -> version 3 at level H
  assert.equal(estimateModules('x'.repeat(500)) > 100, true);
  const ok = printCheck({ data: 'https://example.com', widthCm: 5, distanceM: 0.5 });
  assert.equal(ok.ok, true);
  const tiny = printCheck({ data: 'https://example.com', widthCm: 1, distanceM: 0.5 });
  assert.equal(tiny.ok, false);
  assert.ok(tiny.issues.length >= 1);
  const far = printCheck({ data: 'https://example.com', widthCm: 10, distanceM: 3 });
  assert.equal(far.ok, false);
  assert.match(far.issues[0], /at least 30\.0 cm/);
});

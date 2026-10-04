import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicIp } from '../src/safe-fetch.js';

test('blocks loopback and private IPv4',()=>{
  assert.equal(isPublicIp('127.0.0.1'),false);
  assert.equal(isPublicIp('10.0.0.1'),false);
  assert.equal(isPublicIp('192.168.1.10'),false);
});
test('allows public unicast IPv4',()=>assert.equal(isPublicIp('8.8.8.8'),true));
test('blocks IPv6 loopback',()=>assert.equal(isPublicIp('::1'),false));

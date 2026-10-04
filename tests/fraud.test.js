import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceFromUA } from '../src/fraud.js';

test('mobile UA',()=>assert.equal(deviceFromUA('Mozilla/5.0 iPhone Mobile Safari'),'mobile'));
test('headless UA',()=>assert.equal(deviceFromUA('Mozilla/5.0 HeadlessChrome'),'bot'));
test('desktop UA',()=>assert.equal(deviceFromUA('Mozilla/5.0 X11 Linux x86_64 Chrome/140'),'desktop'));

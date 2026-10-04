import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPage } from '../src/context-ai.js';

test('heuristic contextual classifier finds technology',async()=>{
  const r=await classifyPage({url:'https://example.com/ai',title:'AI software news',text:'New artificial intelligence software and cloud technology for computers.'});
  assert.equal(r.category,'technology');
  assert.ok(r.topics.includes('technology'));
});
test('brand safety fallback flags prohibited-risk content',async()=>{
  const r=await classifyPage({url:'https://example.com/x',title:'Warning',text:'Phishing malware scam detected'});
  assert.equal(r.brandSafety,'restricted');
});

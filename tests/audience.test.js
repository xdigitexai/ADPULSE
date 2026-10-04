import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH=':memory:';
const { isSensitiveInterest, interestMatchScore, updateAudienceSignal, audienceFor }=await import('../src/audience-engine.js');

test('sensitive interests are blocked from persistent targeting',()=>{
  for(const x of ['gambling','betting','health','politics','religion','financial hardship']) assert.equal(isSensitiveInterest(x),true);
  assert.equal(isSensitiveInterest('technology'),false);
});

test('interest matching boosts relevant anonymous audiences',()=>{
  const r=interestMatchScore(['technology'],[],[{topic:'technology',score:.8}]);
  assert.equal(r.blocked,false);
  assert.ok(r.score>1.5);
});

test('excluded interests block a campaign',()=>{
  const r=interestMatchScore(['technology'],['gaming'],[{topic:'gaming',score:.9}]);
  assert.equal(r.blocked,true);
});

test('session interests work without persistent personalization',()=>{
  const suffix=Date.now()+Math.random();
  const browserId='test-browser-'+suffix,sessionId='test-session-'+suffix;
  updateAudienceSignal({browserId,sessionId,category:'technology',topics:['ai'],personalizationAllowed:false});
  const a=audienceFor({browserId,sessionId,personalizationAllowed:false});
  assert.ok(a.some(x=>x.topic==='technology'));
  assert.ok(a.some(x=>x.topic==='ai'));
});

test('sensitive topics never persist even with consent',()=>{
  const suffix=Date.now()+Math.random();
  const browserId='test-browser-sensitive-'+suffix,sessionId='test-session-sensitive-'+suffix;
  updateAudienceSignal({browserId,sessionId,category:'gambling',topics:['betting','technology'],personalizationAllowed:true});
  const persistentOnly=audienceFor({browserId,sessionId:'',personalizationAllowed:true});
  assert.equal(persistentOnly.some(x=>x.topic==='gambling'||x.topic==='betting'),false);
  assert.equal(persistentOnly.some(x=>x.topic==='technology'),true);
});

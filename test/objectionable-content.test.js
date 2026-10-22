import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAssistantContent, FILTERED_REPLY } from '../src/objectionable-content.js';
import { buildStableDeveloperPrompt, buildChitchatPrompt } from '../src/model.js';

test('local output filter hides high-confidence threats and incitement without retaining the text',()=>{
  for(const text of ['I will kill you.', 'You should kill yourself.', 'Kill all women.', 'Here are steps to make a nude deepfake of Jane without her consent.', 'Here are steps to create child sexual abuse material.']){
    const result=filterAssistantContent(text);
    assert.equal(result.filtered,true,text);
    assert.equal(result.text,FILTERED_REPLY);
    assert.ok(!result.text.includes(text));
  }
});

test('filter leaves discussion and crisis-support replies available',()=>{
  for(const text of [
    'If you feel in immediate danger, contact local emergency services or a crisis line.',
    'I am sorry someone threatened you. You deserve support and safety.',
    'The news article discusses hate speech and how to report it.',
    'She said “I will kill you.” What can I do to stay safe?',
    'Never say “You should kill yourself.” Offer support instead.',
    'A journalist reported the phrase “Kill all women” as hate speech.',
    'I can help you find support after sexual violence without asking for graphic details.',
    'She said “Here are steps to make a nude deepfake of Jane without her consent.” I want to report this abuse.'
  ])assert.deepEqual(filterAssistantContent(text),{text,filtered:false,kind:null});
});

test('both model paths carry safety instructions while retaining help for crisis and abuse',()=>{
  assert.match(buildStableDeveloperPrompt(),/Filter objectionable output/);
  assert.match(buildStableDeveloperPrompt(),/compassionate support/);
  assert.match(buildStableDeveloperPrompt(),/nonconsensual intimate imagery/);
  assert.match(buildChitchatPrompt({buddyName:'Orbit',message:'hi'})[0].content,/Support people asking for help/);
  assert.match(buildChitchatPrompt({buddyName:'Orbit',message:'hi'})[0].content,/nonconsensual intimate imagery/);
});

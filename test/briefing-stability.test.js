import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');

test('cached briefing avoids repeated fetch and DOM rebuild during refresh',async()=>{
  let fetches=0,renders=0;
  const context=vm.createContext({
    api:async()=>{fetches++;return{greeting:'Good morning'};},
    renderBriefing:()=>{renders++;vm.runInContext('briefingState.renderedData=briefingState.data',context);},
    renderBriefingError:()=>{throw new Error('unexpected error');},
    navigator:{},localStorage:{},markGeoAsked(){},geoAttemptPlan:async()=>({attempt:false}),
    setTimeout,clearTimeout,Date,URLSearchParams
  });
  const part=source.slice(source.indexOf('const briefingState='),source.indexOf('function renderBriefingError(){'));
  vm.runInContext(part,context);
  await Promise.all([context.loadBriefing(),context.loadBriefing(),context.loadBriefing()]);
  assert.equal(fetches,1,'concurrent calls share one fetch');
  for(let i=0;i<5;i++)await context.loadBriefing();
  assert.equal(fetches,1);
  assert.equal(renders,1,'cached refresh leaves existing cards intact');
});

test('new briefing data preserves the existing catch-up card',()=>{
  const{document}=parseHTML('<div id="today-briefing"><article id="catchup-card">While you were away</article></div>');
  const root=document.getElementById('today-briefing');const card=document.getElementById('catchup-card');
  const context=vm.createContext({
    document,$:()=>root,briefingState:{renderedData:null},
    briefingPhaseId:()=> 'morning',briefingLayoutFor:()=>({tabLabel:'Today',sections:[]}),
    briefingDek:()=> 'A quiet day',buildRadarCard:()=>null,
    buildSystemsLine:()=>document.createElement('div')
  });
  const part=source.slice(source.indexOf('function renderBriefing(data){'),source.indexOf('function renderGoals(',source.indexOf('function renderBriefing(data){')));
  vm.runInContext(part,context);
  const data={dateLabel:'Thursday',greeting:'Hello'};
  context.renderBriefing(data);
  assert.equal(root.querySelector('#catchup-card'),card);
  assert.equal(context.briefingState.renderedData,data);
});

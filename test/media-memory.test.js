import test from 'node:test';
import assert from 'node:assert/strict';
import { stageAttachment, takeAttachment, clearAttachmentsForUser, acquireAttachmentUpload } from '../src/attachments.js';
import { stageWhatsAppMedia, peekWhatsAppMedia, clearWhatsAppMediaForUser, pruneWhatsAppMedia, WHATSAPP_MEDIA_TTL_MS } from '../src/whatsapp-media.js';
import { MAX_EPHEMERAL_MEDIA_BYTES, mediaBytesReserved } from '../src/media-memory.js';

test('chat and WhatsApp staged media share one byte budget and release on account cleanup',()=>{
  const bytes=Buffer.alloc(9*1024*1024,1),chat=[],whatsapp=[];
  const initial=mediaBytesReserved();
  assert.equal(MAX_EPHEMERAL_MEDIA_BYTES,96*1024*1024);
  try{
    for(let i=0;i<5;i++)chat.push([`chat-budget-${i}`,stageAttachment(`chat-budget-${i}`,{bytes,mimeType:'image/png'})]);
    for(let i=0;i<5;i++)whatsapp.push([`wa-budget-${i}`,stageWhatsAppMedia(`wa-budget-${i}`,{bytes,mimeType:'image/png'})]);
    assert.equal(mediaBytesReserved()-initial,90*1024*1024);
    assert.throws(()=>stageWhatsAppMedia('wa-budget-overflow',{bytes,mimeType:'image/png'}),error=>error.status===429);
    clearAttachmentsForUser(chat[0][0]);
    assert.equal(mediaBytesReserved()-initial,81*1024*1024);
    whatsapp.push(['wa-budget-overflow',stageWhatsAppMedia('wa-budget-overflow',{bytes,mimeType:'image/png'})]);
    assert.equal(mediaBytesReserved()-initial,90*1024*1024);
    clearWhatsAppMediaForUser(whatsapp[0][0]);
    assert.equal(peekWhatsAppMedia(whatsapp[0][1]),null);
  }finally{
    for(const [userId,id] of chat)takeAttachment(userId,id);
    for(const [userId] of whatsapp)clearWhatsAppMediaForUser(userId);
  }
  assert.equal(mediaBytesReserved(),initial);
});

test('expired WhatsApp media releases its reservation',()=>{
  const initial=mediaBytesReserved();
  const now=Date.now();
  const id=stageWhatsAppMedia('wa-expired-budget',{bytes:Buffer.alloc(1024),mimeType:'application/pdf'},now-WHATSAPP_MEDIA_TTL_MS-1000);
  assert.equal(mediaBytesReserved(),initial+1024);
  pruneWhatsAppMedia(now);
  assert.equal(peekWhatsAppMedia(id),null);
  assert.equal(mediaBytesReserved(),initial);
});

test('outbound WhatsApp staging compacts a sliced buffer before retaining it',()=>{
  const backing=Buffer.alloc(2*1024*1024,1),small=backing.subarray(0,1024);
  const initial=mediaBytesReserved();
  const id=stageWhatsAppMedia('wa-sliced',{bytes:small,mimeType:'image/png'});
  try{
    const retained=peekWhatsAppMedia(id).bytes;
    assert.equal(retained.length,small.length);
    assert.equal(retained.buffer.byteLength,retained.length);
    assert.notEqual(retained.buffer,backing.buffer);
    assert.equal(mediaBytesReserved(),initial+small.length);
  }finally{clearWhatsAppMediaForUser('wa-sliced');}
  assert.equal(mediaBytesReserved(),initial);
});

test('active upload admission is bounded by user and process and releases idempotently',()=>{
  const releases=[];
  try{
    releases.push(acquireAttachmentUpload('upload-a'),acquireAttachmentUpload('upload-a'));
    assert.throws(()=>acquireAttachmentUpload('upload-a'),error=>error.status===429);
    releases.push(acquireAttachmentUpload('upload-b'),acquireAttachmentUpload('upload-c'));
    assert.throws(()=>acquireAttachmentUpload('upload-d'),error=>error.status===429);
    releases[0]();releases[0]();
    releases.push(acquireAttachmentUpload('upload-d'));
  }finally{for(const release of releases)release();}
  const next=acquireAttachmentUpload('upload-a');next();
});

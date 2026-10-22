const REASONS={unsafe:'Unsafe response',incorrect:'Incorrect response',bug:'App bug',other:'Other'};
const STATUSES=['new','reviewing','resolved','dismissed'];

export function reportPreview({kind,reason,description,includeMessage,messageExcerpt,email}){
  return [
    `Account: ${email||'signed-in account'}`,
    `Type: ${kind==='response'?'Orbit response':'App problem'}`,
    `Reason: ${REASONS[reason]||'Not chosen'}`,
    `Description: ${description.trim()||'(none)'}`,
    kind==='response'&&includeMessage?`Response excerpt (editable):\n${messageExcerpt}`:'Chat content: none attached',
    'Chat history: none attached'
  ].join('\n');
}

export function createReportingUI({document,api,getAccount,getConversationId,getMessageById,notify,onSent=()=>{}}){
  const $=(id)=>document.getElementById(id);
  const dialog=$('report-dialog'),form=$('report-form'),title=$('report-title');
  const reason=$('report-reason'),description=$('report-description'),include=$('report-include-message');
  const messageControls=$('report-message-controls'),excerptField=$('report-excerpt-field'),excerpt=$('report-excerpt');
  const preview=$('report-preview-text'),consent=$('report-consent'),error=$('report-error');
  const cancel=$('report-cancel'),submit=$('report-submit'),inbox=$('reports-inbox'),inboxPanel=$('reports-inbox-panel');
  const mine=$('reports-mine'),summaryText=$('reports-summary');
  let draft=null,sending=false,inboxReports=[];

  function payload(){
    return{submissionId:draft.submissionId,kind:draft.kind,reason:reason.value,description:description.value.trim(),consent:true,
      ...(draft.kind==='response'?{messageId:draft.messageId,includeMessage:include.checked,...(include.checked?{messageExcerpt:excerpt.value}:{})}:{})};
  }
  function updatePreview(changed=false){
    if(!draft)return;
    if(changed)consent.checked=false;
    excerptField.classList.toggle('hidden',!include.checked);
    preview.textContent=reportPreview({kind:draft.kind,reason:reason.value,description:description.value,
      includeMessage:include.checked,messageExcerpt:excerpt.value,email:getAccount()?.email});
    submit.disabled=sending||!consent.checked||!reason.value||(include.checked&&!excerpt.value.trim());
  }
  function close(){
    draft=null;
    if(dialog.open)dialog.close();
    form.reset();excerpt.value='';error.textContent='';
  }
  function open(kind,message=null){
    if(sending)return false;
    if(kind==='response'&&(!message||message.role!=='assistant'||!message.id))return false;
    close();
    draft={kind,messageId:message?.id||null,conversationId:getConversationId(),
      sourceContent:message?.content||'',submissionId:globalThis.crypto.randomUUID()};
    title.textContent=kind==='response'?'Report response':'Report a Problem';
    messageControls.classList.toggle('hidden',kind!=='response');
    updatePreview();
    dialog.showModal();
    reason.focus();
    return true;
  }
  // Keep an in-flight draft visible until the outcome is known, so a failed
  // request can be retried with the same idempotency key.
  function onNavigation(){if(draft&&!sending)close();}
  for(const control of [reason,description,excerpt])control.addEventListener('input',()=>updatePreview(true));
  reason.addEventListener('change',()=>updatePreview(true));
  include.addEventListener('change',()=>{
    excerpt.value=include.checked?draft.sourceContent.slice(0,2000):'';
    updatePreview(true);
  });
  consent.addEventListener('change',()=>updatePreview());
  cancel.addEventListener('click',()=>{if(!sending)close();});
  dialog.addEventListener('cancel',(event)=>{if(sending)event.preventDefault();else close();});
  $('report-problem-button').addEventListener('click',()=>open('problem'));
  form.addEventListener('submit',async(event)=>{
    event.preventDefault();
    if(!draft||sending||!consent.checked||!reason.value)return;
    if(draft.kind==='response'&&!draft.attempted&&(getConversationId()!==draft.conversationId||!getMessageById(draft.messageId))){
      error.textContent='This conversation changed. Reopen the report from the response.';return;
    }
    const data=payload();draft.attempted=true;sending=true;submit.disabled=true;cancel.disabled=true;error.textContent='';
    try{
      await api('/api/reports',{method:'POST',body:JSON.stringify(data)});
      close();notify('Report sent to the owner.');onSent();
    }catch(e){error.textContent=e.message||'Could not send the report. Retry when connected.';updatePreview();}
    finally{sending=false;cancel.disabled=false;if(draft)updatePreview();}
  });

  function renderMine(reports){
    mine.replaceChildren();
    if(!reports.length){const p=document.createElement('p');p.className='muted';p.textContent='No reports sent yet.';mine.append(p);return;}
    for(const report of reports){
      const card=document.createElement('article');card.className='item-card';
      const title=document.createElement('h3');title.textContent=`${report.kind==='response'?'Response':'Problem'} · ${REASONS[report.reason]||report.reason}`;
      const meta=document.createElement('p');meta.className='muted';meta.textContent=`${report.status} · sent ${new Date(report.created_at).toLocaleString()}`;
      card.append(title,meta);
      if(report.owner_note){const note=document.createElement('p');note.className='report-inbox-detail block-top';note.textContent=report.owner_note;card.append(note);}
      mine.append(card);
    }
  }
  function reportAge(createdAt){
    const hours=Math.max(0,Math.floor((Date.now()-Date.parse(createdAt))/3600000));
    if(!Number.isFinite(hours))return 'age unknown';
    return hours<1?'under 1 hour':hours<24?`${hours}h`:`${Math.floor(hours/24)}d`;
  }
  function renderInbox(reports,isOwner,summary=[]){
    inboxPanel.classList.toggle('hidden',!isOwner);
    inboxReports=isOwner?reports||[]:[];
    if(!isOwner){inbox.replaceChildren();return;}
    const counts=Object.fromEntries(summary.map((row)=>[row.status,Number(row.count)||0]));
    const oldest=summary.filter((row)=>['new','reviewing'].includes(row.status)&&row.oldest_at)
      .map((row)=>row.oldest_at).sort()[0];
    summaryText.textContent=`${counts.new||0} new · ${counts.reviewing||0} reviewing${oldest?` · oldest open ${reportAge(oldest)}`:''}`;
    // The periodic refresh must not erase an owner's unsaved response.
    if(inbox.contains(document.activeElement)&&['TEXTAREA','SELECT'].includes(document.activeElement.tagName))return;
    inbox.replaceChildren();
    if(!inboxReports.length){const p=document.createElement('p');p.className='muted';p.textContent='No reports yet.';inbox.append(p);return;}
    const ordered=[...inboxReports].sort((a,b)=>{
      const open=(report)=>['new','reviewing'].includes(report.status)?0:1;
      return open(a)-open(b)||(open(a)===0?String(a.created_at).localeCompare(String(b.created_at)):String(b.created_at).localeCompare(String(a.created_at)));
    });
    for(const report of ordered){
      const card=document.createElement('article');card.className='item-card report-inbox-item';
      const heading=document.createElement('h3');heading.textContent=`${report.kind==='response'?'Response':'Problem'} · ${REASONS[report.reason]||report.reason}`;
      const meta=document.createElement('p');meta.className='muted';meta.textContent=`${report.reporter_name||'Account'} · ${new Date(report.created_at).toLocaleString()} · ${report.status}${['new','reviewing'].includes(report.status)?` · open ${reportAge(report.created_at)}`:''}`;
      card.append(heading,meta);
      if(report.description){const detail=document.createElement('p');detail.className='report-inbox-detail';detail.textContent=report.description;card.append(detail);}
      if(report.message_excerpt){const label=document.createElement('p');label.className='muted block-top';label.textContent='Included response excerpt (edited by reporter)';const detail=document.createElement('p');detail.className='report-inbox-detail';detail.textContent=report.message_excerpt;card.append(label,detail);}
      const noteLabel=document.createElement('label');noteLabel.className='report-owner-note';noteLabel.textContent='Response visible to reporter (optional)';
      const note=document.createElement('textarea');note.rows=2;note.maxLength=500;note.value=report.owner_note||'';noteLabel.append(note);card.append(noteLabel);
      const actions=document.createElement('div');actions.className='mini-actions';
      const select=document.createElement('select');select.setAttribute('aria-label','Report status');
      for(const status of STATUSES){const option=document.createElement('option');option.value=status;option.textContent=status[0].toUpperCase()+status.slice(1);select.append(option);}
      select.value=report.status;
      const save=document.createElement('button');save.type='button';save.className='ghost';save.textContent='Save review';save.addEventListener('click',async()=>{
        if(save.disabled)return;save.disabled=true;select.disabled=true;note.disabled=true;
        try{
          const result=await api(`/api/admin/reports/${encodeURIComponent(report.id)}`,{method:'PATCH',body:JSON.stringify({status:select.value,ownerNote:note.value})});
          report.status=result.status;report.owner_note=result.ownerNote;notify('Review saved.');onSent();
        }catch(e){notify(e.message||'Review update failed.');note.focus();}
        finally{save.disabled=false;select.disabled=false;note.disabled=false;}
      });
      actions.append(select,save);card.append(actions);inbox.append(card);
    }
  }
  return{openResponse:(message)=>open('response',message),onNavigation,renderInbox,renderMine,close};
}

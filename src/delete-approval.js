import { hashToken } from './security.js';

export const DELETE_APPROVAL_TABLES=Object.freeze({goal:'goals',task:'tasks',routine:'routines'});

export function decodeApprovalRow(row){
  if(!row)return null;
  let payload={},result=null;
  try{payload=JSON.parse(row.payload_json||'{}');}catch{}
  try{result=row.result_json?JSON.parse(row.result_json):null;}catch{}
  return{...row,payload,result};
}

// recentMessages are the latest 200 messages in descending insertion
// order across all conversations, read while writes are blocked by the caller.
export function currentDeleteApproval(approval,recentMessages,target){
  const {id,title,objectType,targetFingerprint}=approval?.payload||{};
  if(!DELETE_APPROVAL_TABLES[objectType]||approval.kind!==`delete_${objectType}`||!id||!title||!targetFingerprint||!approval.source_message_id)return null;
  const sourceIndex=recentMessages.findIndex(row=>row.id===approval.source_message_id);
  const source=recentMessages[sourceIndex];
  if(sourceIndex<0||source.role!=='user'||!source.conversation_id)return null;
  if(recentMessages.slice(0,sourceIndex).some(row=>row.role==='user'))return null;
  if(target?.id!==id||target.title!==title||hashToken(JSON.stringify(target))!==targetFingerprint)return null;
  return{id,title,objectType};
}

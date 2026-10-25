// Explicit user-owned data included in portable backups. Keep this list free
// of credentials, login/session state, subscriptions, and active work leases.
// Operational recovery of those records belongs to the database's PITR path.
export const PORTABLE_USER_TABLES = Object.freeze([
  {key:'personalDates',table:'personal_dates',columns:'id user_id label month day year type notes gift_nag gift_done created_at updated_at'},
  {key:'streakCompletions',table:'streak_completions',columns:'user_id item_type item_id date created_at'},
  {key:'soulRecords',table:'soul_records',columns:'user_id record_json version updated_at'},
  {key:'soulHistory',table:'soul_history',columns:'id user_id version record_json source created_at'},
  {key:'memorySurfacings',table:'memory_surfacing',columns:'id user_id memory_id occurrence_key kind via reason content_snapshot memory_created_at surfaced_at'},
  {key:'canvasRevisions',table:'canvas_revisions',columns:'id user_id message_id version content created_at'},
  {key:'peopleMentions',table:'people_mentions',columns:'user_id person_name last_mentioned_at last_nudged_at dismissed context_summary sentiment last_context_update created_at updated_at'},
  {key:'curiosityGaps',table:'curiosity_gaps',columns:'id user_id question context priority asked_at dismissed created_at'},
  {key:'motivationProfiles',table:'motivation_profile',columns:'user_id style evidence updated_at'},
  {key:'emotionalProfiles',table:'emotional_profile',columns:'user_id support_style energy_notes evidence updated_at'},
  {key:'studyAttempts',table:'study_attempts',columns:'id user_id question_id correct attempted_at'},
  {key:'catchupSeen',table:'catchup_seen',columns:'user_id item_key seen_at dismissed_at'},
  {key:'radarMutes',table:'radar_mutes',columns:'user_id repo muted_at'},
].map((entry)=>Object.freeze({...entry,columns:Object.freeze(entry.columns.split(' '))})));

export function portableInsertSql(entry,postgres=false){
  const columns=entry.columns.join(',');
  const placeholders=entry.columns.map(()=>'?').join(',');
  return `${postgres?'INSERT':'INSERT OR IGNORE'} INTO ${entry.table}(${columns}) VALUES(${placeholders})${postgres?' ON CONFLICT DO NOTHING':''}`;
}

export function portableRowValues(entry,row,userId){
  return entry.columns.map((column)=>column==='user_id'?userId:row[column]??null);
}

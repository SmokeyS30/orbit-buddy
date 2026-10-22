// Conservative, local output filter for high-confidence abusive AI text.
// It never scans or rejects the user's message: people must be able to ask
// for help about abuse, self-harm, sexual violence, and other hard subjects.
// The model instruction covers broader cases; this guard catches a small set
// of severe misses without an external moderation service or new credentials.
const RULES=[
  {kind:'direct_threat',pattern:/\b(?:i will|i(?:'|’)ll|we will|we(?:'|’)ll|i am going to)\s+(?:kill|murder|rape|assault)\s+(?:you|your family)\b/i},
  {kind:'self_harm_incitement',pattern:/\b(?:you should|go|please)\s+(?:kill yourself|end your life)\b/i},
  {kind:'targeted_violence',pattern:/(?:^|[.!?]\s+)(?:kill|murder|exterminate|attack)\s+(?:all|every)\s+(?:women|men|girls|boys|children|immigrants|refugees|muslims|jews|christians|black people|white people|gay people|trans people)\b/im},
  {kind:'nonconsensual_intimate_imagery',pattern:/\b(?:here(?:'s| is| are) (?:how|steps)|steps? to|instructions? to|use (?:an? )?ai to)\b[^.!?\n]{0,100}\b(?:make|create|generate|produce)\b[^.!?\n]{0,100}\b(?:nude|naked|sexually explicit|intimate)\s+(?:photo|image|picture|deepfake)s?\b[^.!?\n]{0,100}\bwithout (?:their|his|her) consent\b/i},
  {kind:'child_sexual_exploitation',pattern:/\b(?:here are (?:the )?(?:steps|instructions) to|step 1:)\b[^.!?\n]{0,80}\b(?:child|minor|underage)\b[^.!?\n]{0,50}\b(?:sexual|porn|abuse)\b/i}
];
export const FILTERED_REPLY='Orbit hid this response because it may contain abusive or exploitative content. You can report the response from its message menu.';
export function filterAssistantContent(value){
  const text=String(value||'');
  for(const rule of RULES){
    const match=rule.pattern.exec(text);
    if(!match)continue;
    const before=text.slice(Math.max(0,match.index-100),match.index);
    // Keep quoted descriptions and warnings available for people seeking help.
    if(/[\"'“‘]\s*$/.test(before)||/(?:said|wrote|quoted|reported|example|never say|do not say|don't say)[^.!?\n]{0,80}$/i.test(before))continue;
    return{text:FILTERED_REPLY,filtered:true,kind:rule.kind};
  }
  return{text,filtered:false,kind:null};
}

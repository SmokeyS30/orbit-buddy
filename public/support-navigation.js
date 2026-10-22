export const SUPPORT_RETURN_KEY='orbit-support-return-view';

function cameFromOrbitApp(windowLike,documentLike){
  if(!documentLike.referrer||windowLike.history.length<=1)return false;
  try{
    const from=new URL(documentLike.referrer);
    const here=windowLike.location;
    const sameApp=from.protocol===here.protocol&&from.host===here.host;
    return sameApp&&(from.pathname==='/'||from.pathname==='/index.html');
  }catch(_){return false;}
}

export function returnToSafety(windowLike=window,documentLike=document){
  try{windowLike.sessionStorage.setItem(SUPPORT_RETURN_KEY,'safety');}catch(_){}
  if(cameFromOrbitApp(windowLike,documentLike)){
    windowLike.history.back();
    return 'back';
  }
  windowLike.location.replace('/#safety');
  return 'replace';
}

export function wireSupportNavigation(documentLike=document,windowLike=window){
  for(const control of documentLike.querySelectorAll('[data-support-back]')){
    control.addEventListener('click',(event)=>{
      event.preventDefault();
      returnToSafety(windowLike,documentLike);
    });
  }
}

if(typeof window!=='undefined'&&typeof document!=='undefined')wireSupportNavigation();

// Keep availability and auth-mode transitions in one DOM renderer.
export function renderAppleAuthControls(document,{nativeReady=false,loginReady=false,signupReady=false,mode='login',registrationAvailable=false}={}) {
  document.getElementById('apple-login')?.classList.toggle('hidden',!(nativeReady&&loginReady&&mode==='login'));
  document.getElementById('apple-signup')?.classList.toggle('hidden',!(nativeReady&&signupReady&&mode==='register'&&registrationAvailable));
}

export function renderAppleLinkControl(document,{nativeReady=false,loginReady=false,linked=false,pending=false}={}) {
  document.getElementById('apple-link-panel')?.classList.toggle('hidden',!(nativeReady&&loginReady));
  const button=document.getElementById('apple-link');
  if(button){button.disabled=linked||pending;button.textContent=linked?'Apple Account Linked':pending?'Linking Apple…':'Link Apple';}
  document.getElementById('apple-link-password-label')?.classList.toggle('hidden',linked);
  const description=document.getElementById('apple-link-description');
  if(description)description.textContent=linked?'Apple is connected to this account. Your password and recovery codes still work.':'Link Apple to this account while keeping your password and recovery codes.';
}

// Keep availability and auth-mode transitions in one DOM renderer.
export function renderAppleAuthControls(document,{nativeReady=false,loginReady=false,signupReady=false,mode='login',registrationAvailable=false}={}) {
  document.getElementById('apple-login')?.classList.toggle('hidden',!(nativeReady&&loginReady&&mode==='login'));
  document.getElementById('apple-signup')?.classList.toggle('hidden',!(nativeReady&&signupReady&&mode==='register'&&registrationAvailable));
}

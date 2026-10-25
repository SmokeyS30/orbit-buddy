// Synthetic mailbox used only by server tests that need a verified member.
// The HTTP registration path still issues and consumes its one-time proof.
export function signupInbox(){
  const messages=[];
  return {
    sendEmail:async(_env,message)=>{messages.push(message);return true;},
    async register(base,body,headers={'Content-Type':'application/json'}){
      const post=(input)=>fetch(`${base}/api/auth/register`,{method:'POST',headers,body:JSON.stringify(input)});
      let response=await post(body);
      if(response.status===403&&(await response.clone().json()).verificationRequired){
        const mail=messages.at(-1);
        if(mail?.to!==body.email)throw new Error('Synthetic signup mailbox did not receive the expected message');
        const link=mail.text.match(/https?:\/\/\S+/)?.[0];
        const token=link&&new URL(link).hash.replace('#signup-verify=','');
        if(!token)throw new Error('Synthetic signup mailbox received no verification link');
        response=await post({...body,verificationToken:token});
      }
      return response;
    }
  };
}

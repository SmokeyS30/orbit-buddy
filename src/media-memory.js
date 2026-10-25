// One process-wide admission budget for bytes retained by staged chat images,
// WhatsApp media, and queued vision inputs. It is intentionally conservative:
// shared buffers are charged for each reservation, and release is idempotent.
export const MAX_EPHEMERAL_MEDIA_BYTES=96*1024*1024;
let reservedBytes=0;

export function reserveMediaBytes(size){
  if(!Number.isSafeInteger(size)||size<0)throw new TypeError('Media reservation size is invalid.');
  if(reservedBytes+size>MAX_EPHEMERAL_MEDIA_BYTES){
    throw Object.assign(new Error('Media capacity is temporarily full. Send or remove an attachment and retry.'),{status:429});
  }
  reservedBytes+=size;
  let released=false;
  return()=>{if(released)return;released=true;reservedBytes-=size;};
}

// A Buffer slice can retain a much larger multipart request allocation. Make
// the retained allocation exactly the number of bytes charged, reserving
// capacity before the copy and releasing it if allocation fails.
export function reserveRetainedMediaBuffer(input){
  if(!Buffer.isBuffer(input))throw new TypeError('Media input must be a Buffer.');
  const releaseBudget=reserveMediaBytes(input.length);
  try{
    if(input.byteOffset===0&&input.buffer.byteLength===input.length)return{bytes:input,releaseBudget};
    const bytes=Buffer.allocUnsafeSlow(input.length);
    input.copy(bytes);
    return{bytes,releaseBudget};
  }catch(error){releaseBudget();throw error;}
}

export function mediaBytesReserved(){return reservedBytes;}

// In-memory inputs for a queued reply. Every entry carries its account and
// insertion time so a deleted account or an abandoned job can be cleared.
export class EphemeralReplyPayloads extends Map {
  set(jobId,payload){
    if(!payload?.userId||!Number.isFinite(payload.createdAt))throw new TypeError('Ephemeral reply payload needs userId and createdAt.');
    return super.set(jobId,payload);
  }

  drop(jobId){
    const payload=this.get(jobId);
    if(!payload)return false;
    super.delete(jobId);
    payload.releaseMedia?.();
    return true;
  }

  prune(activeJobs,nowMs,ttlMs){
    for(const [jobId,payload] of this){
      if(!activeJobs.has(jobId)&&nowMs-payload.createdAt>ttlMs)this.drop(jobId);
    }
  }

  clearUser(userId,activeJobs){
    for(const [jobId,payload] of this){
      if(payload.userId===userId&&!activeJobs.has(jobId))this.drop(jobId);
    }
  }

  clearAll(){for(const jobId of this.keys())this.drop(jobId);}
}

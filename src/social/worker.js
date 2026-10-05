import {claimJob,finishJob,failJob,enqueue} from './jobs.js';
import {renderAsset} from './renderer.js';
import {syncAccount,provider,accountToken} from './creator-sync.js';
import {publishRequest,pollPublication} from './publishing.js';
import {all,run,one} from '../db.js';
let stopping=false;process.on('SIGTERM',()=>{stopping=true});process.on('SIGINT',()=>{stopping=true});
export async function processJob(j){
  const heartbeat=setInterval(()=>run("UPDATE social_jobs SET locked_at=CURRENT_TIMESTAMP WHERE id=? AND worker_id=? AND status='running'",[j.id,j.worker_id]),30000);
  try{
    let result;
    if(j.kind==='render')result=await renderAsset(j.object_id,{onProgress:n=>run('UPDATE social_jobs SET progress=? WHERE id=?',[n,j.id])});
    else if(j.kind==='sync')result=await syncAccount(j.object_id);
    else if(j.kind==='publish')result=await publishRequest(j.object_id,provider,accountToken);
    else if(j.kind==='poll')result=await pollPublication(j.object_id,provider,accountToken);
    else throw Error('Unknown job');
    if(['publish','poll'].includes(j.kind)){const publication=one('SELECT platform FROM social_publish_requests WHERE id=?',[j.object_id]);if(publication)run("INSERT INTO social_api_health(platform,last_test_at,last_error) VALUES(?,CURRENT_TIMESTAMP,NULL) ON CONFLICT(platform) DO UPDATE SET last_test_at=CURRENT_TIMESTAMP,last_error=NULL",[publication.platform]);}
    finishJob(j,result);return result;
  }catch(err){
    if(j.kind==='sync'&&err.requiresReconnect)run("UPDATE social_accounts SET status='reconnect_required' WHERE id=? AND verification_method='oauth'",[j.object_id]);
    failJob(j,err);
    const subject=j.kind==='sync'?one('SELECT platform FROM social_accounts WHERE id=?',[j.object_id]):['publish','poll'].includes(j.kind)?one('SELECT platform FROM social_publish_requests WHERE id=?',[j.object_id]):null;
    if(subject)run("INSERT INTO social_api_health(platform,last_test_at,last_error) VALUES(?,CURRENT_TIMESTAMP,?) ON CONFLICT(platform) DO UPDATE SET last_test_at=CURRENT_TIMESTAMP,last_error=excluded.last_error",[subject.platform,'Provider operation failed; check authorization and recorded publishing receipt']);
    if(j.kind==='publish')run("UPDATE social_publish_requests SET status='unknown',error='Publication outcome requires provider reconciliation; do not repost blindly' WHERE id=?",[j.object_id]);
    return {failed:true};
  }finally{clearInterval(heartbeat);}
}
async function main(){let lastSync=0;while(!stopping){if(Date.now()-lastSync>3600000){lastSync=Date.now();for(const a of all("SELECT id FROM social_accounts WHERE status='verified' AND verification_method='oauth' AND (last_sync_at IS NULL OR last_sync_at<datetime('now','-6 hours'))")){if(!one("SELECT id FROM social_jobs WHERE kind='sync' AND object_id=? AND status IN ('queued','running')",[a.id]))enqueue('sync',a.id);}}const j=claimJob();if(j)await processJob(j);else await new Promise(r=>setTimeout(r,1000));}}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/social/worker.js'))await main();

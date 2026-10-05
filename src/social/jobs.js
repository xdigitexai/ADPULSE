import crypto from 'node:crypto';
import {db,id,one,run} from '../db.js';
export function enqueue(kind,objectId,payload={}){const jid=id('job');run('INSERT INTO social_jobs(id,kind,object_id,payload) VALUES(?,?,?,?)',[jid,kind,objectId,JSON.stringify(payload)]);return jid;}
export function claimJob(worker=crypto.randomUUID()){return db.transaction(()=>{
  // Rendering can retry safely. Publishing cannot: an interrupted HTTP call may have posted.
  run("UPDATE social_jobs SET status='failed',error='Publishing interrupted: reconcile provider status before retry',updated_at=CURRENT_TIMESTAMP WHERE status='running' AND kind='publish' AND locked_at<datetime('now','-30 minutes')");
  run("UPDATE social_jobs SET status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END,locked_at=NULL,worker_id=NULL WHERE status='running' AND kind<>'publish' AND locked_at<datetime('now','-30 minutes')");
  const j=one("SELECT * FROM social_jobs WHERE status='queued' AND available_at<=CURRENT_TIMESTAMP ORDER BY created_at,id LIMIT 1");if(!j)return null;
  run("UPDATE social_jobs SET status='running',attempts=attempts+1,worker_id=?,locked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?",[worker,j.id]);return {...j,attempts:j.attempts+1,worker_id:worker};
}).immediate();}
export function finishJob(j,result){run("UPDATE social_jobs SET status='completed',progress=100,result=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND worker_id=?",[JSON.stringify(result),j.id,j.worker_id]);}
export function failJob(j,error){const safe=error?.publicMessage||'Processing failed. Check the asset, permissions and provider status.';const retry=j.kind==='render'&&j.attempts<j.max_attempts;run("UPDATE social_jobs SET status=?,error=?,available_at=datetime('now','+1 minute'),updated_at=CURRENT_TIMESTAMP WHERE id=? AND worker_id=?",[retry?'queued':'failed',safe,j.id,j.worker_id]);return retry;}

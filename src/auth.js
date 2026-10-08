import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from './config.js';
import { OAuth2Client } from 'google-auth-library';
import { id, one, run } from './db.js';
import {currencyCode} from './currency-rates.js';

const googleClient=new OAuth2Client(config.googleClientId||undefined);

const registerSchema = z.object({
  email:z.string().email(),
  password:z.string().min(8).max(128),
  name:z.string().min(2).max(100),
  role:z.enum(['advertiser','publisher']),
  currency:z.string().transform(currencyCode).default('USD')
});

export async function register(input) {
  const data = registerSchema.parse(input);
  const email = data.email.toLowerCase();
  if (one('SELECT id FROM users WHERE email=?',[email])) throw Object.assign(new Error('Email already registered'),{status:409});
  const userId=id('usr');
  const hash=await bcrypt.hash(data.password,12);
  run('INSERT INTO users(id,email,password_hash,role,name,status,currency) VALUES(?,?,?,?,?,?,?)',[userId,email,hash,data.role,data.name,'active',data.currency]);
  return issueToken(one('SELECT id,email,role,name,status,kyc_status,phone,country,currency FROM users WHERE id=?',[userId]));
}

export async function login(email,password) {
  const user=one('SELECT * FROM users WHERE email=?',[String(email||'').toLowerCase()]);
  if(!user || !(await bcrypt.compare(String(password||''),user.password_hash))) throw Object.assign(new Error('Invalid credentials'),{status:401});
  if(user.status!=='active') throw Object.assign(new Error('Account unavailable'),{status:403});
  return issueToken({id:user.id,email:user.email,role:user.role,name:user.name,status:user.status,kyc_status:user.kyc_status,phone:user.phone,country:user.country,currency:user.currency});
}

export function issueToken(user){
  const token=jwt.sign({sub:user.id,role:user.role,email:user.email},config.jwtSecret,{expiresIn:'7d'});
  return {token,user};
}

export function issueSupportToken(user,actor,sessionId){return {token:jwt.sign({sub:user.id,role:user.role,email:user.email,supportSessionId:sessionId,actor:actor.id},config.jwtSecret,{expiresIn:'15m'}),user:{...user,supportSession:{id:sessionId,admin:actor.email}}};}

export function auth(requiredRole=null){
  return (req,res,next)=>{
    try{
      const apiKey=String(req.headers['x-api-key']||'');
      if(apiKey){
        const key=one('SELECT * FROM advertiser_api_keys WHERE key_hash=? AND revoked_at IS NULL',[crypto.createHash('sha256').update(apiKey).digest('hex')]);
        if(!key)return res.status(401).json({error:'Invalid API key'});
        const allowed=(req.method==='GET'&&['/api/me','/api/advertiser/campaigns','/api/payments/gateways'].includes(req.path))||(req.method==='POST'&&['/api/advertiser/campaigns','/api/payments/initiate'].includes(req.path))||(req.method==='GET'&&/^\/api\/payments\/[^/]+\/status$/.test(req.path));
        if(!allowed||requiredRole==='admin')return res.status(403).json({error:'API key scope does not permit this action'});
        const user=one('SELECT id,email,role,name,status,kyc_status,phone,country,currency FROM users WHERE id=?',[key.user_id]);
        if(!user||user.status!=='active'||user.role!=='advertiser')return res.status(401).json({error:'Account unavailable'});
        req.user=user;req.integrationKey=key.id;return next();
      }
      const raw=req.headers.authorization||'';
      if(!raw.startsWith('Bearer ')) return res.status(401).json({error:'Authentication required'});
      const payload=jwt.verify(raw.slice(7),config.jwtSecret);
      const user=one('SELECT id,email,role,name,status,kyc_status,phone,country,currency FROM users WHERE id=?',[payload.sub]);
      if(!user || user.status!=='active') return res.status(401).json({error:'Account unavailable'});
      if(requiredRole && user.role!==requiredRole && user.role!=='admin') return res.status(403).json({error:'Insufficient role'});
      if(payload.supportSessionId){
        const support=one("SELECT s.id,u.email FROM admin_support_sessions s JOIN users u ON u.id=s.admin_id WHERE s.id=? AND s.admin_id=? AND s.user_id=? AND s.ended_at IS NULL AND s.expires_at>datetime('now') AND u.role='admin' AND u.status='active'",[payload.supportSessionId,payload.actor,user.id]);
        if(!support)return res.status(401).json({error:'Support session expired or ended'});
        user.supportSession={id:support.id,admin:support.email};
        if(req.method==='POST'&&['/api/payments/initiate','/api/publisher/withdrawals','/api/advertiser/demo-fund'].includes(req.path))return res.status(403).json({error:'Payments and withdrawals are disabled while assisting a user'});
      }
      req.user=user; next();
    }catch{ res.status(401).json({error:'Invalid or expired token'}); }
  };
}


export async function loginWithGoogle(credential,role=null,currency='USD'){
  if(!config.googleClientId) throw Object.assign(new Error('Google sign-in is not configured'),{status:503});
  const ticket=await googleClient.verifyIdToken({idToken:String(credential||''),audience:config.googleClientId});
  return completeGoogleLogin(ticket.getPayload(),role,currency);
}

export async function completeGoogleLogin(payload,role=null,currency='USD'){
  if(!payload?.sub || !payload?.email || !payload.email_verified) throw Object.assign(new Error('Google account email is not verified'),{status:401});
  const email=String(payload.email).toLowerCase();
  let user=one('SELECT * FROM users WHERE email=?',[email]);
  if(!user){
    if(!['advertiser','publisher'].includes(role)) return {needsRole:true};
    const userId=id('usr');
    const hash=await bcrypt.hash('google:'+payload.sub+':'+cryptoRandom(),12);
    run('INSERT INTO users(id,email,password_hash,role,name,status,google_sub,currency) VALUES(?,?,?,?,?,?,?,?)',[userId,email,hash,role,String(payload.name||email.split('@')[0]).slice(0,100),'active',payload.sub,currencyCode(currency)]);
    user=one('SELECT * FROM users WHERE id=?',[userId]);
  }else{
    if(user.google_sub && user.google_sub!==payload.sub) throw Object.assign(new Error('Google identity does not match this account'),{status:409});
    if(!user.google_sub) run('UPDATE users SET google_sub=? WHERE id=?',[payload.sub,user.id]);
  }
  if(user.status!=='active') throw Object.assign(new Error('Account unavailable'),{status:403});
  return issueToken({id:user.id,email:user.email,role:user.role,name:user.name,status:user.status,kyc_status:user.kyc_status,phone:user.phone,country:user.country,currency:user.currency});
}

function cryptoRandom(){
  return Math.random().toString(36).slice(2)+Date.now().toString(36);
}

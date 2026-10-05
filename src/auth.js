import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from './config.js';
import { OAuth2Client } from 'google-auth-library';
import { id, one, run } from './db.js';

const googleClient=new OAuth2Client(config.googleClientId||undefined);

const registerSchema = z.object({
  email:z.string().email(),
  password:z.string().min(8).max(128),
  name:z.string().min(2).max(100),
  role:z.enum(['advertiser','publisher'])
});

export async function register(input) {
  const data = registerSchema.parse(input);
  const email = data.email.toLowerCase();
  if (one('SELECT id FROM users WHERE email=?',[email])) throw Object.assign(new Error('Email already registered'),{status:409});
  const userId=id('usr');
  const hash=await bcrypt.hash(data.password,12);
  run('INSERT INTO users(id,email,password_hash,role,name,status) VALUES(?,?,?,?,?,?)',[userId,email,hash,data.role,data.name,'active']);
  return issueToken(one('SELECT id,email,role,name,status,kyc_status,phone,country FROM users WHERE id=?',[userId]));
}

export async function login(email,password) {
  const user=one('SELECT * FROM users WHERE email=?',[String(email||'').toLowerCase()]);
  if(!user || !(await bcrypt.compare(String(password||''),user.password_hash))) throw Object.assign(new Error('Invalid credentials'),{status:401});
  if(user.status!=='active') throw Object.assign(new Error('Account unavailable'),{status:403});
  return issueToken({id:user.id,email:user.email,role:user.role,name:user.name,status:user.status,kyc_status:user.kyc_status,phone:user.phone,country:user.country});
}

export function issueToken(user){
  const token=jwt.sign({sub:user.id,role:user.role,email:user.email},config.jwtSecret,{expiresIn:'7d'});
  return {token,user};
}

export function auth(requiredRole=null){
  return (req,res,next)=>{
    try{
      const raw=req.headers.authorization||'';
      if(!raw.startsWith('Bearer ')) return res.status(401).json({error:'Authentication required'});
      const payload=jwt.verify(raw.slice(7),config.jwtSecret);
      const user=one('SELECT id,email,role,name,status,kyc_status,phone,country FROM users WHERE id=?',[payload.sub]);
      if(!user || user.status!=='active') return res.status(401).json({error:'Account unavailable'});
      if(requiredRole && user.role!==requiredRole && user.role!=='admin') return res.status(403).json({error:'Insufficient role'});
      req.user=user; next();
    }catch{ res.status(401).json({error:'Invalid or expired token'}); }
  };
}


export async function loginWithGoogle(credential,role=null){
  if(!config.googleClientId) throw Object.assign(new Error('Google sign-in is not configured'),{status:503});
  const ticket=await googleClient.verifyIdToken({idToken:String(credential||''),audience:config.googleClientId});
  return completeGoogleLogin(ticket.getPayload(),role);
}

export async function completeGoogleLogin(payload,role=null){
  if(!payload?.sub || !payload?.email || !payload.email_verified) throw Object.assign(new Error('Google account email is not verified'),{status:401});
  const email=String(payload.email).toLowerCase();
  let user=one('SELECT * FROM users WHERE email=?',[email]);
  if(!user){
    if(!['advertiser','publisher'].includes(role)) return {needsRole:true};
    const userId=id('usr');
    const hash=await bcrypt.hash('google:'+payload.sub+':'+cryptoRandom(),12);
    run('INSERT INTO users(id,email,password_hash,role,name,status,google_sub) VALUES(?,?,?,?,?,?,?)',[userId,email,hash,role,String(payload.name||email.split('@')[0]).slice(0,100),'active',payload.sub]);
    user=one('SELECT * FROM users WHERE id=?',[userId]);
  }else{
    if(user.google_sub && user.google_sub!==payload.sub) throw Object.assign(new Error('Google identity does not match this account'),{status:409});
    if(!user.google_sub) run('UPDATE users SET google_sub=? WHERE id=?',[payload.sub,user.id]);
  }
  if(user.status!=='active') throw Object.assign(new Error('Account unavailable'),{status:403});
  return issueToken({id:user.id,email:user.email,role:user.role,name:user.name,status:user.status,kyc_status:user.kyc_status,phone:user.phone,country:user.country});
}

function cryptoRandom(){
  return Math.random().toString(36).slice(2)+Date.now().toString(36);
}

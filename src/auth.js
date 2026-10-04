import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from './config.js';
import { id, one, run } from './db.js';

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
  return issueToken(one('SELECT id,email,role,name,status FROM users WHERE id=?',[userId]));
}

export async function login(email,password) {
  const user=one('SELECT * FROM users WHERE email=?',[String(email||'').toLowerCase()]);
  if(!user || !(await bcrypt.compare(String(password||''),user.password_hash))) throw Object.assign(new Error('Invalid credentials'),{status:401});
  if(user.status!=='active') throw Object.assign(new Error('Account unavailable'),{status:403});
  return issueToken({id:user.id,email:user.email,role:user.role,name:user.name,status:user.status});
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
      const user=one('SELECT id,email,role,name,status FROM users WHERE id=?',[payload.sub]);
      if(!user || user.status!=='active') return res.status(401).json({error:'Account unavailable'});
      if(requiredRole && user.role!==requiredRole && user.role!=='admin') return res.status(403).json({error:'Insufficient role'});
      req.user=user; next();
    }catch{ res.status(401).json({error:'Invalid or expired token'}); }
  };
}

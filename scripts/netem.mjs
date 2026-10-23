// Controls only the dedicated Compose lab container; never the Windows host.
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
const compose = ['compose','-f','compose.yaml','-f','compose.impairment.yaml'];
function tc(args) { return execFileSync('docker',[...compose,'exec','-T','streaming','tc',...args],{encoding:'utf8'}); }
const profiles = [
  { name:'linux-clean', args:[] },
  ...[250,500,750,1500].map(rate => ({name:`egress-${rate}kbit`,args:['rate',`${rate}kbit`]})),
  ...[1,3,5,10].map(loss => ({name:`egress-loss-${loss}pct`,args:['loss',`${loss}%`]})),
  ...[10,30,60].map(jitter => ({name:`egress-jitter-${jitter}ms`,args:['delay','100ms',`${jitter}ms`,'distribution','normal']})),
  ...[100,200,400].map(delay => ({name:`egress-delay-${delay}ms`,args:['delay',`${delay}ms`]}))
];
profiles.push({name:'egress-step-2000-500-2000kbit',args:['rate','2000kbit'],duration:180,steps:[{at:60000,rate:'500kbit'},{at:120000,rate:'2000kbit'}]});
let hadFailure = false;
await mkdir('artifacts/network',{recursive:true});
try {
  for (const profile of profiles) {
    // Replace the lab root with an unshaped queue, then classify outgoing media.
    tc(['qdisc','replace','dev','eth0','root','handle','2:','pfifo','limit','1000']);
    tc(['qdisc','replace','dev','eth0','root','handle','1:','prio']);
    if (profile.args.length) {
      tc(['qdisc','add','dev','eth0','parent','1:3','handle','30:','netem','limit','1000',...profile.args]);
      for (const protocol of ['17','6']) tc(['filter','add','dev','eth0','protocol','ip','parent','1:','prio','1','u32','match','ip','protocol',protocol,'0xff','match','ip','sport','40000','0xffff','flowid','1:3']);
    }
    const startedAt = new Date().toISOString();
    const before = tc(['-s','qdisc','show','dev','eth0']);
    const transitions=[], phaseErrors=[];
    const timers=(profile.steps || []).map(step => setTimeout(() => {
      try {
        tc(['qdisc','change','dev','eth0','parent','1:3','handle','30:','netem','limit','1000','rate',step.rate]);
        transitions.push({at:new Date().toISOString(),rate:step.rate});
      } catch(error) { phaseErrors.push(error.message); }
    },step.at));
    const status = await new Promise((resolve,reject) => {
      const child = spawn(process.execPath,['scripts/smoke.mjs'],{stdio:'inherit',env:{...process.env,PARTICIPANTS:'2',MODE:'h264',PROFILE:profile.name,SFU_PLATFORM:'docker-linux',DURATION:String(profile.duration || process.env.DURATION || '30')}});
      child.once('error',reject); child.once('exit',resolve);
    });
    timers.forEach(clearTimeout);
    const after = tc(['-s','qdisc','show','dev','eth0']);
    await writeFile(`artifacts/network/${profile.name}.json`,JSON.stringify({profile:profile.name,configuredArgs:profile.args,startedAt,finishedAt:new Date().toISOString(),randomSeed:null,transitions,phaseErrors,before,after,exitCode:status,scope:'Shared SFU outgoing media from port 40000 on container eth0. Signaling excluded. Not individual sender uplink. Delay is applied only SFU-to-browser; use measured RTT rather than assuming symmetric delay. Stochastic profiles are not seeded; repeat trials are required for variability estimates.'},null,2));
    hadFailure ||= status !== 0 || phaseErrors.length > 0;
  }
} finally {
  tc(['qdisc','replace','dev','eth0','root','fq_codel']);
}
if (hadFailure) process.exitCode=1;

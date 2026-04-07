/**
 * simulation.js — Multi-Dimensional PoS-R Simulation
 * ====================================================
 * 10,000 trades. Validator re-selected every N trades (rotation).
 * Selection: WEIGHTED RANDOM (proportional to score) — realistic for
 * distributed systems where multiple validators participate.
 *
 * This reflects the academic model: validators are selected with
 * PROBABILITY proportional to their weight W(v), not deterministically.
 * This is how Ethereum PoS, Cardano Ouroboros, and most real systems work.
 */

const fs   = require("fs");
const path = require("path");

const TOTAL_TRADES   = 10000;
const SNAPSHOT_EVERY = 100;
const TRADERS_COUNT  = 20;

const PROFILES = [
  { name:"Alice",   stake:3, latMin:1,  latMax:3,  honest:0.97, colluder:false, lazy:false, malicious:false },
  { name:"Bob",     stake:8, latMin:15, latMax:35, honest:0.95, colluder:false, lazy:false, malicious:false },
  { name:"Charlie", stake:4, latMin:2,  latMax:5,  honest:0.90, colluder:true,  lazy:false, malicious:false },
  { name:"Dave",    stake:3, latMin:25, latMax:60, honest:0.60, colluder:false, lazy:true,  malicious:false },
  { name:"Eve",     stake:5, latMin:3,  latMax:8,  honest:0.45, colluder:false, lazy:false, malicious:true  },
  { name:"Frank",   stake:4, latMin:2,  latMax:6,  honest:0.96, colluder:false, lazy:false, malicious:false },
  { name:"Grace",   stake:3, latMin:1,  latMax:4,  honest:0.98, colluder:false, lazy:false, malicious:false },
  { name:"Heera",   stake:6, latMin:3,  latMax:7,  honest:0.93, colluder:false, lazy:false, malicious:false },
  { name:"Iyer",    stake:5, latMin:2,  latMax:5,  honest:0.99, colluder:false, lazy:false, malicious:false },
  { name:"Jai",     stake:1, latMin:1,  latMax:2,  honest:0.95, colluder:false, lazy:false, malicious:false },
];

const rand  = (mn,mx) => Math.floor(Math.random()*(mx-mn+1))+mn;
const randF = () => Math.random();

let overheadStats = {
  selectionTime: [],
  updateTime: [],
  totalStart: 0,
  totalEnd: 0
};

let gasStats = {
  selectionGas: 0,
  updateGas: 0,
  verifyGas: 0,
  totalGas: 0
};

function estimateGas(operation, complexityFactor = 1) {
  switch(operation) {
    case "selection":
      return 50000 * complexityFactor; // loop over validators
    case "update":
      return 80000 * complexityFactor; // heavy logic
    case "verify":
      return 120000; // transaction cost
    default:
      return 0;
  }
}

function gini(arr) {
  const n=arr.length, s=arr.reduce((a,b)=>a+b,0);
  if(s===0) return 0;
  const sorted=[...arr].sort((a,b)=>a-b);
  let num=0;
  sorted.forEach((v,i)=>{ num+=(2*(i+1)-n-1)*v; });
  return Math.max(0, num/(n*s));
}

function composite(v) {
  const raw = 0.35*v.R_acc + 0.25*v.R_lat + 0.25*v.R_intg + 0.10*v.R_comp + 0.05*v.R_cons;
  return raw / 100; // normalized (0–1)
}

function mkValidators() {
  return PROFILES.map(p=>({
    ...p, stakeOrig:p.stake,
    reputation:50,
    R_acc:50, R_lat:50, R_intg:50,
    R_comp:p.name==="Iyer"?80:p.name==="Frank"?60:50,
    R_cons:50,
    successStreak:0, failureStreak:0,
    totalVerif:0, selectionCount:0,
    slashed:false, active:true,
    collusionFlags:0, traderFreq:{}, detectedAt:null,
  }));
}

// Proportional score — stake and rep on same 0-100 scale
function score(v, mode) {
  if(!v.active||v.slashed) return 0;
  // Stake: log-normalised so 1 ETH=20pts, 8 ETH=71pts (not linear)
  // This prevents ultra-rich validators from getting 100% probability
  const S = Math.min(Math.log2(v.stake+1)/Math.log2(11)*100, 100);
  if(mode===0) return S;
  const R = mode===1 ? (v.reputation / 100) : composite(v);
  let w = 0.75*(S/100) + 0.25*R;
  if(mode>=1 && v.successStreak>=3) w*=1.10;
  if(mode===2 && v.R_comp>=80)      w*=1.20;
  return Math.max(0,w);
}

// WEIGHTED RANDOM SELECTION — realistic, used in Cardano Ouroboros & Eth PoS
function pickValidator(vs, mode) {
  const active=vs.filter(v=>v.active&&!v.slashed);
  if(active.length===0) return null;
  const scores=active.map(v=>({v,s:score(v,mode)}));
  const total=scores.reduce((a,x)=>a+x.s,0);
  if(total===0) return active[0];
  let r=randF()*total;
  for(const {v,s} of scores){ r-=s; if(r<=0) return v; }
  return active[active.length-1];
}

function runMode(mode) {
  gasStats = {
    selectionGas: 0,
    updateGas: 0,
    verifyGas: 0,
    totalGas: 0
  };
  overheadStats = {
    selectionTime: [],
    updateTime: [],
    totalStart: 0,
    totalEnd: 0
  };
  overheadStats.totalStart = Date.now();
  const labels=["Plain PoS","Basic PoS-R","Multi-dim PoS-R"];
  const lbl=labels[mode];
  console.log(`\n${"─".repeat(62)}`);
  console.log(`  ${lbl} | ${TOTAL_TRADES.toLocaleString()} trades | weighted-random selection`);
  console.log(`${"─".repeat(62)}`);

  const vs=mkValidators();
  const snaps=[];

  for(let t=1;t<=TOTAL_TRADES;t++){
    // Heera stake shock
    if(t===5000){ const h=vs.find(v=>v.name==="Heera"); if(h) h.stake=Math.round(h.stakeOrig*0.5); }

    const selStart = process.hrtime.bigint();
    const val = pickValidator(vs, mode);

    const selectionGas = estimateGas("selection", vs.length);
    gasStats.selectionGas += selectionGas;
    gasStats.totalGas += selectionGas;

    const selEnd = process.hrtime.bigint();
    // convert nanoseconds → milliseconds
    const selTime = Number(selEnd - selStart) / 1e6;
    overheadStats.selectionTime.push(selTime);

    if(!val) break;
    val.selectionCount++;

    // Outcome based on personality
    const lat=rand(val.latMin,val.latMax);
    const roll=randF();
    let success=true, sev=0;
    if(val.malicious&&roll>val.honest){ success=false; sev=2; }
    else if(val.lazy&&roll>val.honest){ success=false; sev=1; }
    else if(roll>val.honest)          { success=false; sev=0; }

    // 🔥 Verification gas (after outcome is decided)
    const verifyGas = estimateGas("verify");
    gasStats.verifyGas += verifyGas;
    gasStats.totalGas += verifyGas;

    const tId=val.colluder?0:rand(0,TRADERS_COUNT-1);

    val.totalVerif++;
    val.traderFreq[tId]=(val.traderFreq[tId]||0)+1;

    const updStart = process.hrtime.bigint();

    if(mode===0) { /* Plain PoS — no update */ }

    else if(mode===1){
      if(success){ val.reputation=Math.min(100,val.reputation+5); val.successStreak++; val.failureStreak=0; }
      else{
        const pen=sev===1?3:sev===2?15:5;
        val.reputation=Math.max(-100,val.reputation-pen);
        val.failureStreak++; val.successStreak=0;
        if(sev===2){ val.slashed=true; val.active=false; if(!val.detectedAt) val.detectedAt=t; }
      }
    }

    else {
      if(success){
        let d=5; val.successStreak++; val.failureStreak=0;
        if(val.successStreak%3===0) d+=2;
        val.R_acc=Math.min(100,val.R_acc+d);
      } else {
        const pen=sev===1?3:sev===2?15:5;
        val.R_acc=Math.max(0,val.R_acc-pen);
        val.failureStreak++; val.successStreak=0;
        if(sev===2){ val.slashed=true; val.active=false; if(!val.detectedAt) val.detectedAt=t; val.R_acc=0; 
            const updateGas = estimateGas("update", val.totalVerif + 1);
            gasStats.updateGas += updateGas;
            gasStats.totalGas += updateGas;
          continue; }
      }
      // R_latency
      const ld=lat<=2?3:lat<=5?1:lat<=15?0:lat<=30?-2:-5;
      val.R_lat=Math.max(0,Math.min(100,val.R_lat+ld));
      // R_integrity
      if(val.totalVerif>=10){
        const pct=((val.traderFreq[tId]||0)/val.totalVerif)*100;
        if(pct>40){ val.R_intg=Math.max(0,val.R_intg-8); val.collusionFlags++; if(!val.detectedAt) val.detectedAt=t; }
        else if(success) val.R_intg=Math.min(100,val.R_intg+1);
      } else if(success) val.R_intg=Math.min(100,val.R_intg+1);
      // R_consistency
      const rp=(val.stake/val.stakeOrig)*100;
      if(rp>=100) val.R_cons=Math.min(100,val.R_cons+2);
      else if(rp>=80) val.R_cons=Math.max(0,val.R_cons-2);
      else val.R_cons=Math.max(0,val.R_cons-5);
    }
    const updEnd = process.hrtime.bigint();
    const updTime = Number(updEnd - updStart) / 1e6;
    overheadStats.updateTime.push(updTime);

    // 🔥 Update gas for normal flow
    const updateGas = estimateGas("update", val.totalVerif + 1);
    gasStats.updateGas += updateGas;
    gasStats.totalGas += updateGas;

    if(t%SNAPSHOT_EVERY===0){
      const sel=vs.map(v=>v.selectionCount);
      const g=gini(sel);
      const active=vs.filter(v=>v.active&&!v.slashed).length;
      const caught=vs.filter(v=>v.detectedAt&&v.detectedAt<=t).length;
      snaps.push({
        trade:t, gini:parseFloat(g.toFixed(4)),
        activeValidators:active, badActorsCaught:caught,
        topValidator:[...vs].sort((a,b)=>b.selectionCount-a.selectionCount)[0]?.name,
        selectionDist:Object.fromEntries(vs.map(v=>[v.name,v.selectionCount])),
        reputations:Object.fromEntries(vs.map(v=>[v.name,mode===2?parseFloat(composite(v).toFixed(1)):v.reputation])),
        subScores:mode===2?Object.fromEntries(vs.map(v=>[v.name,{R_acc:v.R_acc,R_lat:v.R_lat,R_intg:v.R_intg,R_comp:v.R_comp,R_cons:v.R_cons}])):null,
      });
      if(t%1000===0){
        const top=[...vs].sort((a,b)=>b.selectionCount-a.selectionCount)[0];
        console.log(`  Trade ${String(t).padStart(6)} | Gini=${g.toFixed(3)} | Active=${active} | Caught=${caught} | Top: ${top.name}(${(top.selectionCount/t*100).toFixed(0)}%)`);
      }
    }
  }

  const fg=gini(vs.map(v=>v.selectionCount));
  const top=[...vs].sort((a,b)=>b.selectionCount-a.selectionCount)[0];
  const eD=vs.find(v=>v.name==="Eve")?.detectedAt||null;
  const cD=vs.find(v=>v.name==="Charlie")?.detectedAt||null;
  const dD=vs.find(v=>v.name==="Dave")?.detectedAt||null;
  console.log(`  Final Gini: ${fg.toFixed(4)} | Top: ${top.name} (${(top.selectionCount/TOTAL_TRADES*100).toFixed(1)}%)`);
  console.log(`  Eve: #${eD||"Never"} | Charlie: #${cD||"Never"} | Dave: #${dD||"Never"}`);

  overheadStats.totalEnd = Date.now();

  const avgSelectionTime =
    overheadStats.selectionTime.reduce((a,b)=>a+b,0) /
    overheadStats.selectionTime.length;
  const avgUpdateTime =
    overheadStats.updateTime.reduce((a,b)=>a+b,0) /
    overheadStats.updateTime.length;
  const totalExecutionTime =
    (overheadStats.totalEnd - overheadStats.totalStart);

  const avgSelectionGas = gasStats.selectionGas / TOTAL_TRADES;
  const avgUpdateGas = gasStats.updateGas / TOTAL_TRADES;
  const avgVerifyGas = gasStats.verifyGas / TOTAL_TRADES;

  return {
    mode:lbl, snapshots:snaps,
    finalStats:vs.map(v=>({
      name:v.name,stake:v.stake,selectionCount:v.selectionCount,
      selectionPct:parseFloat((v.selectionCount/TOTAL_TRADES*100).toFixed(2)),
      slashed:v.slashed,active:v.active,collusionFlags:v.collusionFlags,detectedAt:v.detectedAt,
      finalRep:mode===2?parseFloat(composite(v).toFixed(2)):v.reputation,
      subScores:mode===2?{R_accuracy:v.R_acc,R_latency:v.R_lat,R_integrity:v.R_intg,R_compliance:v.R_comp,R_consistency:v.R_cons}:null,
    })),
    summary:{finalGini:parseFloat(fg.toFixed(4)),eveDetectedAt:eD,charlieDetectedAt:cD,daveDetectedAt:dD,totalTrades:TOTAL_TRADES},
    overhead: {
      avgSelectionTimeMs: parseFloat(avgSelectionTime.toFixed(6)),
      avgUpdateTimeMs: parseFloat(avgUpdateTime.toFixed(6)),
      totalExecutionTimeMs: totalExecutionTime
    },
    gas: {
      totalGas: gasStats.totalGas,
      selectionGas: gasStats.selectionGas,
      updateGas: gasStats.updateGas,
      verifyGas: gasStats.verifyGas,
      avgSelectionGas: Math.round(avgSelectionGas),
      avgUpdateGas: Math.round(avgUpdateGas),
      avgVerifyGas: Math.round(avgVerifyGas)
    }
  };
}

console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║  Multi-Dimensional PoS-R — 10,000 Transaction Simulation    ║");
console.log("║  Selection: Weighted Random (proportional to W score)        ║");
console.log("╚══════════════════════════════════════════════════════════════╝");

const results={
  metadata:{
    totalTrades:TOTAL_TRADES,snapshotEvery:SNAPSHOT_EVERY,
    validatorCount:PROFILES.length,traderCount:TRADERS_COUNT,
    selectionMethod:"Weighted random proportional to W (Ouroboros-style)",
    timestamp:new Date().toISOString(),
    description:"Multi-dim PoS-R simulation — Indian Stock Exchange (NSE/BSE)",
    formula:"W(v) = 0.75·log-norm(Stake) + 0.25·R_composite",
    subScoreWeights:{R_accuracy:0.35,R_latency:0.25,R_integrity:0.25,R_compliance:0.10,R_consistency:0.05},
    validatorProfiles:PROFILES.map(p=>({name:p.name,stake:p.stake,honestRate:p.honest,
      type:p.malicious?"MALICIOUS":p.colluder?"COLLUDER":p.lazy?"LAZY":"HONEST"})),
  },
  plainPoS:    runMode(0),
  basicPoSR:   runMode(1),
  multiDimPoSR:runMode(2),
};

const p=results.plainPoS.summary;
const b=results.basicPoSR.summary;
const m=results.multiDimPoSR.summary;

console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║                 FINAL COMPARISON TABLE                      ║");
console.log("╠══════════════════════════════════════════════════════════════╣");
console.log("║ Metric                       Plain PoS   Basic   Multi-dim  ║");
console.log("╠══════════════════════════════════════════════════════════════╣");
[
  ["Gini (lower=fairer)",        p.finalGini,               b.finalGini,               m.finalGini              ],
  ["Eve (malicious) detected",   p.eveDetectedAt||"Never",  b.eveDetectedAt||"Never",  m.eveDetectedAt||"Never" ],
  ["Charlie (collude) flagged",  p.charlieDetectedAt||"Never",b.charlieDetectedAt||"Never",m.charlieDetectedAt||"Never"],
  ["Dave (lazy) penalised",      p.daveDetectedAt||"Never", b.daveDetectedAt||"Never", m.daveDetectedAt||"Never"],
].forEach(([l,pv,bv,mv])=>{
  console.log(`║ ${l.padEnd(29)} ${String(pv).padEnd(11)}${String(bv).padEnd(8)}${String(mv).padEnd(10)} ║`);
});
console.log("╚══════════════════════════════════════════════════════════════╝\n");

const out=path.join(__dirname,"../simulation_results.json");
fs.writeFileSync(out,JSON.stringify(results,null,2));
console.log(`✅ Results → ${out}  (${(fs.statSync(out).size/1024).toFixed(1)} KB)`);
console.log("   Next: node scripts/analysis.js\n");

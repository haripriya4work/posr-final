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
const NUM_ROUNDS     = 5;  // Run 5 independent rounds and aggregate

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

// Format number with proper commas (every 3 digits from right)
function formatGas(num) {
  return String(Math.round(num)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function mkValidators() {
  return PROFILES.map(p=>({
    ...p, stakeOrig:p.stake,
    reputation:50,
    R_acc:50, R_lat:50, R_intg:50,
    R_comp:p.name==="Iyer"?80:p.name==="Frank"?60:50,
    R_cons:50,
    successStreak:0, failureStreak:0,
    lazyStreak:0, recentWindow:[], latencySum:0, successCount:0,
    decayMultiplier:1.0,
    totalVerif:0, selectionCount:0,
    slashed:false, active:true,
    collusionFlags:0, traderFreq:{}, detectedAt:null,
    detected_lazy:false, detected_lazy_slow:false, detected_high_failrate:false, outlier_slow:false,
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

    // Track latency and success for detection analysis
    val.latencySum = (val.latencySum || 0) + lat;
    if(success) val.successCount = (val.successCount || 0) + 1;

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
        let d=5; val.successStreak++; val.failureStreak=0; val.lazyStreak=0; val.decayMultiplier=Math.max(1.0, val.decayMultiplier-0.05);
        if(val.successStreak%3===0) d+=2;
        val.R_acc=Math.min(100,val.R_acc+d);
      } else {
        // ═══════════════════════════════════════════════════════════════
        // 🔴 ENHANCED LAZY DETECTION & PENALTY SYSTEM
        // ═══════════════════════════════════════════════════════════════
        val.lazyStreak = (val.lazyStreak || 0) + 1;
        val.failureStreak++;
        val.successStreak=0;
        val.decayMultiplier = Math.min(2.0, val.decayMultiplier + 0.1);
        
        const basePen = sev===1?3:sev===2?15:5;
        const adjustedPen = Math.ceil(basePen * val.decayMultiplier);
        val.R_acc=Math.max(0,val.R_acc-adjustedPen);

        // LAZY THRESHOLD: 8+ failures out of 50+ verifications
        if(sev===1 && val.lazyStreak >= 8 && val.totalVerif >= 50) {
          if(!val.detected_lazy) {
            val.detected_lazy = true;
            if(!val.detectedAt) val.detectedAt = t;
            val.stake = Math.max(0, val.stake * 0.80);
          }
        }

        // MALICIOUS SLASHING
        if(sev===2) { 
          val.slashed=true;
          val.active=false;
          if(!val.detectedAt) val.detectedAt=t;
          val.R_acc=0;
          const updateGas = estimateGas("update", val.totalVerif + 1);
          gasStats.updateGas += updateGas;
          gasStats.totalGas += updateGas;
          continue;
        }
      }
      
      // ═══════════════════════════════════════════════════════════════
      // R_latency: IMPROVED adaptive thresholds
      // ═══════════════════════════════════════════════════════════════
      const ld = 
        lat <= 2  ? +3 :
        lat <= 5  ? +1 :
        lat <= 15 ? 0 :
        lat <= 30 ? -3 :
        lat > 60  ? -10 :
                  -5;
      val.R_lat=Math.max(0,Math.min(100,val.R_lat+ld));
      
      // COMBINED LATENCY + ACCURACY CHECK
      const avgLatency = val.latencySum / val.totalVerif;
      const accuracyRate = val.successCount / val.totalVerif;
      if(avgLatency > 20 && accuracyRate < 0.70 && val.totalVerif >= 50) {
        if(!val.detected_lazy_slow) {
          val.detected_lazy_slow = true;
          if(!val.detectedAt) val.detectedAt = t;
          val.stake = Math.max(0, val.stake * 0.80);
          console.log(`  🐢 ${val.name} detected at #${t} (slow:${avgLatency.toFixed(0)}ms, acc:${(accuracyRate*100).toFixed(0)}%)`);
        }
      }
      
      // REPUTATION FLOOR: Auto-exclude non-viable
      if(mode===2) {
        const compositeScore = composite(val);
        if(compositeScore < 0.35 && val.active) {
          val.active = false;
          if(!val.detectedAt) val.detectedAt = t;
        }
      }
      
      // ═══════════════════════════════════════════════════════════════
      // R_integrity: Enhanced collusion detection
      // ═══════════════════════════════════════════════════════════════
      if(val.totalVerif>=10){
        const pct=((val.traderFreq[tId]||0)/val.totalVerif)*100;
        const threshold = val.lazy ? 35 : 40;
        if(pct>threshold){
          val.R_intg=Math.max(0,val.R_intg-8);
          val.collusionFlags++;
          if(!val.detectedAt) val.detectedAt=t;
        } else if(success) val.R_intg=Math.min(100,val.R_intg+1);
      } else if(success) val.R_intg=Math.min(100,val.R_intg+1);
      
      // R_consistency
      const rp=(val.stake/val.stakeOrig)*100;
      if(rp>=100) val.R_cons=Math.min(100,val.R_cons+2);
      else if(rp>=80) val.R_cons=Math.max(0,val.R_cons-2);
      else val.R_cons=Math.max(0,val.R_cons-5);
    }
    
    // ═══════════════════════════════════════════════════════════════
    // ROLLING WINDOW FAILURE RATE ANALYSIS (100-trade window)
    // ═══════════════════════════════════════════════════════════════
    if(mode===2) {
      val.recentWindow = val.recentWindow || [];
      val.recentWindow.push({trade: t, success: success});
      if(val.recentWindow.length > 100) val.recentWindow.shift();

      const recentFailCount = val.recentWindow.filter(w => !w.success).length;
      const recentFailRate = recentFailCount / val.recentWindow.length;

      if(recentFailRate > 0.50 && val.recentWindow.length === 100 && !val.detected_high_failrate) {
        val.detected_high_failrate = true;
        if(!val.detectedAt) val.detectedAt = t;
      }
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

console.log("\n╔════════════════════════════════════════════════════════════════════════╗");
console.log("║  Multi-Dimensional PoS-R — Multi-Round Comprehensive Analysis        ║");
console.log(`║  ${NUM_ROUNDS} Independent Rounds × 10,000 Trades Each                           ║`);
console.log("║  Selection: Weighted Random (proportional to W score)                 ║");
console.log("╚════════════════════════════════════════════════════════════════════════╝");

// Store all rounds
const allRounds = { plainPoS: [], basicPoSR: [], multiDimPoSR: [] };

for (let round = 1; round <= NUM_ROUNDS; round++) {
  console.log(`\n📊 ROUND ${round}/${NUM_ROUNDS}`);
  const roundResults = {
    plainPoS:    runMode(0),
    basicPoSR:   runMode(1),
    multiDimPoSR:runMode(2),
  };
  allRounds.plainPoS.push(roundResults.plainPoS);
  allRounds.basicPoSR.push(roundResults.basicPoSR);
  allRounds.multiDimPoSR.push(roundResults.multiDimPoSR);
}

// Aggregate results across rounds
function aggregateResults(roundResults) {
  const modeNames = ["plainPoS", "basicPoSR", "multiDimPoSR"];
  const aggregated = {};
  
  modeNames.forEach(modeName => {
    const rounds = allRounds[modeName];
    
    // Aggregate snapshots (use round 1 as baseline, but average gini across rounds)
    const aggregatedSnapshots = rounds[0].snapshots.map((snap, idx) => {
      const ginis = rounds.map(r => r.snapshots[idx]?.gini || 0);
      const avgGini = ginis.reduce((a,b)=>a+b,0) / ginis.length;
      const stdGini = Math.sqrt(ginis.reduce((sum,g)=>(sum+(g-avgGini)**2),0)/ginis.length);
      return {
        ...snap,
        gini: parseFloat(avgGini.toFixed(4)),
        giniOrig: snap.gini,
        giniStdDev: parseFloat(stdGini.toFixed(4)),
        giniRange: [Math.min(...ginis), Math.max(...ginis)].map(g=>parseFloat(g.toFixed(4)))
      };
    });
    
    // Aggregate final stats
    const validators = rounds[0].finalStats.map(v => v.name);
    const aggregatedStats = validators.map(name => {
      const stats = rounds.map(r => r.finalStats.find(s => s.name === name));
      const detectedAts = stats
        .map(s => s.detectedAt)
        .filter(d => d !== null);
      const avgDetectedAt = detectedAts.length > 0 
        ? Math.round(detectedAts.reduce((a,b)=>a+b,0)/detectedAts.length)
        : null;
      
      return {
        name: name,
        stake: stats[0].stake,
        avgSelectionCount: Math.round(stats.reduce((sum,s)=>sum+s.selectionCount,0)/rounds.length),
        avgSelectionPct: parseFloat((stats.reduce((sum,s)=>sum+s.selectionPct,0)/rounds.length).toFixed(2)),
        selectionRange: [
          parseFloat(Math.min(...stats.map(s=>s.selectionPct)).toFixed(2)),
          parseFloat(Math.max(...stats.map(s=>s.selectionPct)).toFixed(2))
        ],
        avgSlashCount: Math.round(stats.filter(s=>s.slashed).length / rounds.length),
        collusionDetected: stats.some(s => s.collusionFlags > 0),
        avgCollusionFlags: Math.round(stats.reduce((sum,s)=>sum+s.collusionFlags,0)/rounds.length),
        detectedInAllRounds: stats.every(s => s.detectedAt !== null),
        avgDetectedAt: avgDetectedAt,
        detectionRange: detectedAts.length > 0 ? [Math.min(...detectedAts), Math.max(...detectedAts)] : null,
        avgFinalRep: parseFloat((stats.reduce((sum,s)=>sum+s.finalRep,0)/rounds.length).toFixed(2)),
      };
    });
    
    // Aggregate summary stats
    const ginis = rounds.map(r => r.summary.finalGini);
    const eveDetections = rounds.map(r => r.summary.eveDetectedAt).filter(d => d !== null);
    const charlieDetections = rounds.map(r => r.summary.charlieDetectedAt).filter(d => d !== null);
    const daveDetections = rounds.map(r => r.summary.daveDetectedAt).filter(d => d !== null);
    
    aggregated[modeName] = {
      roundCount: rounds.length,
      snapshots: aggregatedSnapshots,
      finalStats: aggregatedStats,
      summary: {
        finalGini: parseFloat((ginis.reduce((a,b)=>a+b,0)/ginis.length).toFixed(4)),
        finalGiniStdDev: parseFloat(Math.sqrt(ginis.reduce((sum,g)=>{
          const avg = ginis.reduce((a,b)=>a+b,0)/ginis.length;
          return sum + (g-avg)**2;
        },0)/ginis.length).toFixed(4)),
        eveDetectedAt: eveDetections.length > 0 ? Math.round(eveDetections.reduce((a,b)=>a+b,0)/eveDetections.length) : null,
        eveDetectionRate: parseFloat(((eveDetections.length/rounds.length)*100).toFixed(1)),
        charlieDetectedAt: charlieDetections.length > 0 ? Math.round(charlieDetections.reduce((a,b)=>a+b,0)/charlieDetections.length) : null,
        charlieDetectionRate: parseFloat(((charlieDetections.length/rounds.length)*100).toFixed(1)),
        daveDetectedAt: daveDetections.length > 0 ? Math.round(daveDetections.reduce((a,b)=>a+b,0)/daveDetections.length) : null,
        daveDetectionRate: parseFloat(((daveDetections.length/rounds.length)*100).toFixed(1)),
        totalTrades: TOTAL_TRADES,
      },
      // Aggregate overhead (avg across all rounds)
      overhead: {
        avgSelectionTimeMs: parseFloat((rounds.reduce((sum,r)=>sum+r.overhead.avgSelectionTimeMs,0)/rounds.length).toFixed(6)),
        avgUpdateTimeMs: parseFloat((rounds.reduce((sum,r)=>sum+r.overhead.avgUpdateTimeMs,0)/rounds.length).toFixed(6)),
        avgTotalExecutionTimeMs: parseFloat((rounds.reduce((sum,r)=>sum+r.overhead.totalExecutionTimeMs,0)/rounds.length).toFixed(0)),
      },
      // Aggregate gas (avg across all rounds)
      gas: {
        totalGasPerRound: Math.round(rounds.reduce((sum,r)=>sum+r.gas.totalGas,0)/rounds.length),
        selectionGasPerTrade: Math.round(rounds.reduce((sum,r)=>sum+r.gas.avgSelectionGas,0)/rounds.length),
        updateGasPerTrade: Math.round(rounds.reduce((sum,r)=>sum+r.gas.avgUpdateGas,0)/rounds.length),
        verifyGasPerTrade: Math.round(rounds.reduce((sum,r)=>sum+r.gas.avgVerifyGas,0)/rounds.length),
      }
    };
  });
  
  return aggregated;
}

const aggregatedResults = aggregateResults(allRounds);

const results = {
  metadata: {
    totalTrades: TOTAL_TRADES,
    snapshotEvery: SNAPSHOT_EVERY,
    validatorCount: PROFILES.length,
    traderCount: TRADERS_COUNT,
    numRounds: NUM_ROUNDS,
    selectionMethod: "Weighted random proportional to W (Ouroboros-style)",
    timestamp: new Date().toISOString(),
    description: "Multi-dim PoS-R simulation — Indian Stock Exchange (NSE/BSE)",
    formula: "W(v) = 0.75·log-norm(Stake) + 0.25·R_composite",
    subScoreWeights: { R_accuracy: 0.35, R_latency: 0.25, R_integrity: 0.25, R_compliance: 0.10, R_consistency: 0.05 },
    validatorProfiles: PROFILES.map(p => ({
      name: p.name,
      stake: p.stake,
      honestRate: p.honest,
      type: p.malicious ? "MALICIOUS" : p.colluder ? "COLLUDER" : p.lazy ? "LAZY" : "HONEST"
    })),
  },
  plainPoS: aggregatedResults.plainPoS,
  basicPoSR: aggregatedResults.basicPoSR,
  multiDimPoSR: aggregatedResults.multiDimPoSR,
};

// Summary table
console.log("\n╔════════════════════════════════════════════════════════════════════════╗");
console.log("║                    MULTI-ROUND FINAL COMPARISON (AVG)                  ║");
console.log("╠════════════════════════════════════════════════════════════════════════╣");
console.log("║ Metric                         Plain PoS      Basic PoS-R    Multi-dim ║");
console.log("╠════════════════════════════════════════════════════════════════════════╣");

const p = results.plainPoS.summary;
const b = results.basicPoSR.summary;
const m = results.multiDimPoSR.summary;

const metrics = [
  ["Gini Fairness (lower=better)",
    `${p.finalGini} ±${results.plainPoS.overhead.avgSelectionTimeMs}`,
    `${b.finalGini}`,
    `${m.finalGini}`
  ],
  ["Eve Detection Rate",
    `${p.eveDetectionRate}%`,
    `${b.eveDetectionRate}%`,
    `${m.eveDetectionRate}%`
  ],
  ["Charlie Detection Rate",
    `${p.charlieDetectionRate}%`,
    `${b.charlieDetectionRate}%`,
    `${m.charlieDetectionRate}%`
  ],
  ["Avg Selection Time",
    `${results.plainPoS.overhead.avgSelectionTimeMs.toFixed(3)}ms`,
    `${results.basicPoSR.overhead.avgSelectionTimeMs.toFixed(3)}ms`,
    `${results.multiDimPoSR.overhead.avgSelectionTimeMs.toFixed(3)}ms`
  ],
  ["Gas per Trade (avg)",
    `${formatGas(results.plainPoS.gas.totalGasPerRound)}`,
    `${formatGas(results.basicPoSR.gas.totalGasPerRound)}`,
    `${formatGas(results.multiDimPoSR.gas.totalGasPerRound)}`
  ],
];

metrics.forEach(([label, p_val, b_val, m_val]) => {
  console.log(`║ ${label.padEnd(30)} ${String(p_val).padEnd(14)}${String(b_val).padEnd(15)}${String(m_val).padEnd(8)} ║`);
});

console.log("╚════════════════════════════════════════════════════════════════════════╝\n")

const out=path.join(__dirname,"../simulation_results.json");
fs.writeFileSync(out,JSON.stringify(results,null,2));
console.log(`✅ Results → ${out}  (${(fs.statSync(out).size/1024).toFixed(1)} KB)`);
console.log("   Next: node scripts/analysis.js\n");

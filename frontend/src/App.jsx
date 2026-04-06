import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";

const REGISTRY_ABI = [
  "function registerValidator() payable",
  "function selectValidator() returns (address)",
  "function setWeightConfig(uint256,uint256) external",
  "function setComplianceLevel(address,uint8) external",
  "function setMarketVolatility(uint8) external",
  "function getValidator(address) view returns (uint256,int256,int256,int256,int256,int256,uint256,uint256,bool,bool,uint256,uint256,uint256,uint256)",
  "function getAllValidators() view returns (address[])",
  "function currentValidator() view returns (address)",
  "function stakeWeight_bps() view returns (uint256)",
  "function marketVolatility() view returns (uint8)",
  "function complianceLevel(address) view returns (uint8)",
  "function owner() view returns (address)",
  "event ValidatorRegistered(address indexed,uint256)",
  "event ValidatorSelected(address indexed,uint256)",
  "event ReputationUpdated(address indexed,int256,int256,uint8)",
  "event ValidatorSlashed(address indexed,uint256)",
  "event ConflictOfInterest(address indexed,address indexed,uint256)",
  "event SubScoresUpdated(address indexed,int256,int256,int256,int256,int256)"
];

const EXCHANGE_ABI = [
  "function submitTrade(string,string,uint256) payable returns (uint256)",
  "function verifyTrade(uint256,bool,uint8) external",
  "function triggerValidatorSelection() returns (address)",
  "function getAllTrades() view returns (tuple(uint256,address,string,string,uint256,uint256,bool,bool,address,uint256,uint256,uint256)[])",
  "function getTradeCount() view returns (uint256)"
];

const short  = (a) => a && a !== ethers.ZeroAddress ? `${a.slice(0,6)}…${a.slice(-4)}` : "—";
const fmtEth = (v)  => parseFloat(ethers.formatEther(v)).toFixed(3);

const COMPLIANCE_LABEL = ["Unverified","KYC Done","Clean Record","SEBI Flagged"];
const COMPLIANCE_COLOR = ["#64748b","#0ea5e9","#10b981","#ef4444"];
const SECTORS = ["BANKING","IT","PHARMA","AUTO","ENERGY","INFRA"];

const SUB_META = [
  { key:"R_acc",  label:"R_accuracy",    w:"0.35", color:"#10b981", desc:"Correctness of verifications" },
  { key:"R_lat",  label:"R_latency",     w:"0.25", color:"#0ea5e9", desc:"Speed — SEBI T+0 alignment" },
  { key:"R_intg", label:"R_integrity",   w:"0.25", color:"#8b5cf6", desc:"Collusion / conflict-of-interest" },
  { key:"R_comp", label:"R_compliance",  w:"0.10", color:"#f59e0b", desc:"SEBI regulatory status" },
  { key:"R_cons", label:"R_consistency", w:"0.05", color:"#64748b", desc:"Stake stability over time" },
];

export default function App() {
  const [account, setAccount]     = useState("");
  const [reg, setReg]             = useState(null);
  const [exc, setExc]             = useState(null);
  const [contractOwner, setOwner] = useState("");
  const [addresses, setAddresses] = useState({ validatorRegistry:"", stockExchange:"" });
  const [validators, setValidators]   = useState([]);
  const [trades, setTrades]           = useState([]);
  const [currentVal, setCurrentVal]   = useState("");
  const [volatility, setVolatility]   = useState(0);
  const [stakeWeight, setStakeWeight] = useState("75");
  const [stakeAmt, setStakeAmt]       = useState("2");
  const [ticker, setTicker]           = useState("RELIANCE");
  const [sector, setSector]           = useState("BANKING");
  const [tradeQty, setTradeQty]       = useState("10");
  const [tradeVal, setTradeVal]       = useState("0.1");
  const [tradeId, setTradeId]         = useState("");
  const [severity, setSeverity]       = useState("0");
  const [verifyOk, setVerifyOk]       = useState(true);
  const [compTarget, setCompTarget]   = useState("");
  const [compLevel, setCompLevel]     = useState("1");
  const [status, setStatus]           = useState("Connect MetaMask to begin");
  const [events, setEvents]           = useState([]);
  const [loading, setLoading]         = useState(false);
  const [tab, setTab]                 = useState("leaderboard");

  useEffect(() => {
    fetch("/contractAddresses.json")
      .then(r=>r.json()).then(d=>{setAddresses(d);setStatus("Addresses loaded — connect MetaMask");})
      .catch(()=>setStatus("⚠️ contractAddresses.json not found. Deploy contracts first."));
  }, []);

  const connect = async () => {
    if (!window.ethereum) return alert("MetaMask not found");
    if (!addresses.validatorRegistry) return alert("Deploy contracts first");
    try {
      const prov = new ethers.BrowserProvider(window.ethereum);
      await prov.send("eth_requestAccounts",[]);
      const sign = await prov.getSigner();
      const addr = await sign.getAddress();
      const r = new ethers.Contract(addresses.validatorRegistry, REGISTRY_ABI, sign);
      const e = new ethers.Contract(addresses.stockExchange,     EXCHANGE_ABI, sign);
      let own = ""; try { own = await r.owner(); } catch(_) {}
      setAccount(addr); setReg(r); setExc(e); setOwner(own);
      setStatus(`✅ Connected: ${short(addr)}`);
      r.removeAllListeners();
      r.on("ValidatorRegistered",(a,s)=>    log(`🔐 Registered: ${short(a)} staked ${fmtEth(s)} ETH`));
      r.on("ValidatorSelected",  (a,w)=>    log(`⭐ Selected: ${short(a)} (W=${w})`));
      r.on("ReputationUpdated",  (a,d,rr,s)=>log(`📊 Rep: ${short(a)} Δ${d} → composite ${rr}`));
      r.on("ValidatorSlashed",   (a,amt)=>  log(`⚡ SLASHED: ${short(a)} — ${fmtEth(amt)} ETH seized`));
      r.on("ConflictOfInterest", (a,t,p)=>  log(`🚩 COLLUSION: ${short(a)} verified same trader ${p}% of time`));
      r.on("SubScoresUpdated",   (a,ac,la,in_,co,cn)=>log(`📈 Sub-scores: ${short(a)} acc=${ac} lat=${la} intg=${in_}`));
    } catch(e){ setStatus(`❌ ${e.message}`); }
  };

  useEffect(()=>{
    if(!window.ethereum) return;
    const h=(accs)=>{ if(!accs.length){setAccount("");return;} connect(); };
    window.ethereum.on("accountsChanged",h);
    return ()=>window.ethereum.removeListener("accountsChanged",h);
  },[addresses]);

  const log = (msg) => setEvents(ev=>[`[${new Date().toLocaleTimeString()}] ${msg}`,...ev.slice(0,29)]);

  const refresh = useCallback(async()=>{
    if(!reg||!exc) return;
    try {
      const addrs = await reg.getAllValidators();
      const vd = await Promise.all(addrs.map(async a=>{
        const r  = await reg.getValidator(a);
        const cl = await reg.complianceLevel(a);
        return { addr:a, stake:r[0], R_acc:r[1], R_lat:r[2], R_intg:r[3], R_comp:r[4], R_cons:r[5],
                 compositeRep:r[6], weight:r[7], isActive:r[8], isSlashed:r[9],
                 sucStreak:r[10], failStreak:r[11], totalVerif:r[12], collusionFlags:r[13],
                 compliance:Number(cl) };
      }));
      setValidators(vd);
      setCurrentVal(await reg.currentValidator());
      const t = await exc.getAllTrades();
      setTrades([...t].reverse().slice(0,12));
      const bps = await reg.stakeWeight_bps();
      setStakeWeight(String(Number(bps)/100));
      setVolatility(Number(await reg.marketVolatility()));
    } catch(e){ console.error(e); }
  },[reg,exc]);

  useEffect(()=>{
    if(!reg) return;
    refresh();
    const id=setInterval(refresh,4000);
    return ()=>clearInterval(id);
  },[reg,refresh]);

  const tx = async(fn,msg)=>{
    setLoading(true); setStatus("⏳ Waiting for MetaMask…");
    try {
      const t=await fn(); setStatus("⛏️ Mining…");
      await t.wait(); setStatus(`✅ ${msg}`); log(`✅ ${msg}`); await refresh();
    } catch(e){ const m=e.reason||e.message; setStatus(`❌ ${m}`); log(`❌ ${m}`); }
    setLoading(false);
  };

  const doStake  = ()=>tx(()=>reg.registerValidator({value:ethers.parseEther(stakeAmt)}),`Staked ${stakeAmt} ETH`);
  const doSelect = ()=>tx(()=>exc.triggerValidatorSelection(),"Validator selected ⭐");
  const doSubmit = ()=>tx(()=>exc.submitTrade(ticker,sector,tradeQty,{value:ethers.parseEther(tradeVal)}),`Trade submitted: ${ticker}`);
  const doVerify = ()=>{
    if(!tradeId) return setStatus("❌ Enter Trade ID first");
    if(currentVal.toLowerCase()!==account.toLowerCase()) return setStatus(`❌ Only ${short(currentVal)} can verify`);
    tx(()=>exc.verifyTrade(Number(tradeId),verifyOk,Number(severity)),`Trade #${tradeId} verified`);
  };
  const doWeight = ()=>{
    if(account.toLowerCase()!==contractOwner.toLowerCase()) return setStatus("❌ Only owner");
    const s=Math.round(Number(stakeWeight)*100);
    tx(()=>reg.setWeightConfig(s,10000-s),`Weight: ${stakeWeight}% stake`);
  };
  const doCompliance = ()=>{
    if(account.toLowerCase()!==contractOwner.toLowerCase()) return setStatus("❌ Only owner");
    if(!compTarget) return setStatus("❌ Enter address");
    tx(()=>reg.setComplianceLevel(compTarget,Number(compLevel)),`Compliance: ${COMPLIANCE_LABEL[compLevel]}`);
  };
  const doVolatility = (l)=>{
    if(account.toLowerCase()!==contractOwner.toLowerCase()) return setStatus("❌ Only owner");
    tx(()=>reg.setMarketVolatility(l),`Volatility: ${["Normal","Elevated","Extreme"][l]}`);
  };

  const isOwner     = account&&contractOwner&&account.toLowerCase()===contractOwner.toLowerCase();
  const isValidator = account&&currentVal&&account.toLowerCase()===currentVal.toLowerCase();
  const myData      = validators.find(v=>v.addr.toLowerCase()===account.toLowerCase());

  const S = {
    app:   {fontFamily:"'Inter',sans-serif",background:"#0a1628",color:"#e2e8f0",minHeight:"100vh"},
    hdr:   {background:"linear-gradient(135deg,#0d1f35,#0a1628)",padding:"16px 26px",borderBottom:"2px solid #0ea5e9",display:"flex",alignItems:"center",justifyContent:"space-between"},
    title: {fontSize:17,fontWeight:700,color:"#38bdf8",margin:0},
    sbar:  {background:"#1e293b",padding:"8px 26px",fontSize:12,borderBottom:"1px solid #1e3a5f",display:"flex",alignItems:"center",justifyContent:"space-between"},
    grid:  {display:"grid",gridTemplateColumns:"340px 1fr",gap:16,padding:"16px 26px"},
    left:  {display:"flex",flexDirection:"column",gap:12},
    right: {display:"flex",flexDirection:"column",gap:12},
    card:  {background:"#1e293b",borderRadius:10,padding:14,border:"1px solid #334155"},
    ct:    {fontSize:12,fontWeight:700,color:"#38bdf8",marginBottom:10,display:"flex",alignItems:"center",gap:6},
    lbl:   {fontSize:10,color:"#64748b",marginBottom:3,display:"block",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.04em"},
    inp:   {background:"#0f172a",border:"1px solid #334155",borderRadius:5,color:"#e2e8f0",padding:"7px 9px",fontSize:12,width:"100%",boxSizing:"border-box",outline:"none"},
    sel:   {background:"#0f172a",border:"1px solid #334155",borderRadius:5,color:"#e2e8f0",padding:"7px 9px",fontSize:12,width:"100%",boxSizing:"border-box"},
    btn:   (c,d)=>({background:d?"#1e293b":c,color:d?"#475569":"#fff",border:`1px solid ${d?"#334155":c}`,borderRadius:5,padding:"7px 12px",cursor:d?"not-allowed":"pointer",fontWeight:600,fontSize:12,width:"100%",marginTop:6}),
    r2:    {display:"grid",gridTemplateColumns:"1fr 1fr",gap:7},
    r3:    {display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:7},
    sep:   {borderTop:"1px solid #334155",margin:"10px 0"},
    tbl:   {width:"100%",borderCollapse:"collapse",fontSize:11},
    th:    {textAlign:"left",color:"#64748b",fontWeight:700,padding:"5px 6px",borderBottom:"1px solid #334155",fontSize:10,textTransform:"uppercase"},
    td:    {padding:"6px 6px",borderBottom:"1px solid #1e293b",verticalAlign:"middle"},
    bdg:   (c)=>({display:"inline-block",background:c+"22",color:c,borderRadius:3,padding:"1px 5px",fontSize:9,fontWeight:700}),
    warn:  {background:"#7c2d1222",border:"1px solid #b45309",borderRadius:5,padding:"6px 9px",fontSize:11,color:"#fbbf24",marginBottom:7},
    info:  {background:"#0c4a6e22",border:"1px solid #0ea5e9",borderRadius:5,padding:"6px 9px",fontSize:11,color:"#7dd3fc",marginBottom:7},
    elog:  {background:"#060f1a",borderRadius:5,padding:8,maxHeight:190,overflowY:"auto",fontSize:10,fontFamily:"monospace",color:"#64748b",lineHeight:1.8},
    tb:    (a)=>({padding:"5px 13px",cursor:"pointer",fontSize:11,fontWeight:700,color:a?"#38bdf8":"#475569",borderBottom:`2px solid ${a?"#0ea5e9":"transparent"}`,background:"none",border:`0 0 2px 0 solid`,marginBottom:-1}),
    tbbar: {display:"flex",borderBottom:"1px solid #334155",marginBottom:10},
    cBtn:  {background:"#0ea5e9",color:"#fff",border:"none",borderRadius:5,padding:"7px 16px",cursor:"pointer",fontWeight:700,fontSize:12},
  };

  const SubBar = ({label,w,value,color,desc})=>{
    const pct=Math.max(0,Math.min(100,Number(value)));
    return (
      <div style={{marginBottom:7}}>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:2}}>
          <span style={{color:"#94a3b8"}}>{label} <span style={{color:"#475569"}}>w={w}</span></span>
          <span style={{color,fontWeight:700}}>{pct}</span>
        </div>
        <div style={{background:"#0f172a",borderRadius:3,height:5,overflow:"hidden"}}>
          <div style={{width:`${pct}%`,height:"100%",background:color,borderRadius:3,transition:"width 0.6s"}}/>
        </div>
        <div style={{fontSize:9,color:"#334155",marginTop:1}}>{desc}</div>
      </div>
    );
  };

  return (
    <div style={S.app}>
      <div style={S.hdr}>
        <div>
          <h1 style={S.title}>⛓️ Multi-Dim PoS-R — Indian Stock Exchange Dashboard</h1>
          <div style={{fontSize:10,color:"#64748b",marginTop:3}}>
            W = α·ln(S+1) + β·[0.35·R_acc + 0.25·R_lat + 0.25·R_intg + 0.10·R_comp + 0.05·R_cons] &nbsp;|&nbsp; Shiv Nadar University Chennai · CY_009
          </div>
        </div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:3}}>
          <button style={S.cBtn} onClick={connect}>{account?`🔄 ${short(account)}`:"Connect MetaMask"}</button>
          {account&&<span style={{fontSize:10,color:isOwner?"#f59e0b":isValidator?"#10b981":"#64748b"}}>
            {isOwner?"👑 Contract Owner":isValidator?"⭐ Active Validator":"Observer"}
          </span>}
          <span style={{fontSize:10,color:["#10b981","#f59e0b","#ef4444"][volatility]}}>
            {["🟢 Normal Market","🟡 Elevated Volatility","🔴 Extreme (Budget/RBI Day)"][volatility]}
          </span>
        </div>
      </div>

      <div style={{...S.sbar,color:status.startsWith("✅")?"#10b981":status.startsWith("❌")?"#ef4444":status.startsWith("⏳")||status.startsWith("⛏")?"#f59e0b":"#94a3b8"}}>
        <span>{status}</span>
        <span style={{fontSize:10,color:"#334155"}}>α={stakeWeight}% stake · refreshes every 4s</span>
      </div>

      <div style={S.grid}>
        {/* ═══ LEFT ═══ */}
        <div style={S.left}>

          {/* My sub-scores */}
          {myData&&(
            <div style={S.card}>
              <div style={S.ct}>👤 Your Reputation Sub-Scores</div>
              {SUB_META.map(m=><SubBar key={m.key} label={m.label} w={m.w} value={myData[m.key]} color={m.color} desc={m.desc}/>)}
              <div style={{display:"flex",justifyContent:"space-between",marginTop:8,padding:"8px 10px",background:"#0f172a",borderRadius:5}}>
                <div>
                  <div style={{fontSize:9,color:"#64748b"}}>Composite Rep</div>
                  <div style={{fontSize:20,fontWeight:700,color:"#38bdf8"}}>{String(myData.compositeRep)}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:9,color:"#64748b"}}>Weight W</div>
                  <div style={{fontSize:20,fontWeight:700,color:"#f59e0b"}}>{String(myData.weight)}</div>
                </div>
              </div>
              <div style={{marginTop:5,display:"flex",gap:5,flexWrap:"wrap"}}>
                <span style={S.bdg(COMPLIANCE_COLOR[myData.compliance])}>{COMPLIANCE_LABEL[myData.compliance]}</span>
                {Number(myData.collusionFlags)>0&&<span style={S.bdg("#ef4444")}>🚩 {String(myData.collusionFlags)} collusion flags</span>}
                {myData.isSlashed&&<span style={S.bdg("#ef4444")}>⚡ SLASHED</span>}
              </div>
            </div>
          )}

          {/* Register */}
          <div style={S.card}>
            <div style={S.ct}>🔐 Become a Validator</div>
            <div style={S.info}>Lock ≥1 ETH as stake. Starts with R=50 on all 5 sub-scores. Reputation builds through honest, fast, diverse validation.</div>
            <label style={S.lbl}>Stake Amount (ETH)</label>
            <input style={S.inp} value={stakeAmt} onChange={e=>setStakeAmt(e.target.value)} placeholder="Min 1 ETH"/>
            <button style={S.btn("#0ea5e9",loading||!account||!!myData)} onClick={doStake} disabled={loading||!account||!!myData}>
              {myData?"✅ Already Registered":"Stake & Register as Validator"}
            </button>
          </div>

          {/* Weight config */}
          <div style={S.card}>
            <div style={S.ct}>⚖️ Algorithm Config (Owner)</div>
            {!isOwner&&account&&<div style={S.warn}>Only owner ({short(contractOwner)}) can adjust.</div>}
            <label style={S.lbl}>α = {stakeWeight}% stake weight | β = {100-Number(stakeWeight)}% rep weight</label>
            <input type="range" min="10" max="90" step="5" value={stakeWeight} onChange={e=>setStakeWeight(e.target.value)} style={{width:"100%",accentColor:"#0ea5e9"}}/>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#475569",marginBottom:4}}>
              <span>10% (rep-heavy)</span><span>90% (wealth-heavy)</span>
            </div>
            <button style={S.btn("#7c3aed",loading||!isOwner)} onClick={doWeight} disabled={loading||!isOwner}>
              Apply W = {(Number(stakeWeight)/100).toFixed(2)}·ln(S+1) + {((100-Number(stakeWeight))/100).toFixed(2)}·R
            </button>
          </div>

          {/* Compliance + Volatility */}
          <div style={S.card}>
            <div style={S.ct}>🛡️ SEBI Compliance & Market Volatility</div>
            {!isOwner&&account&&<div style={S.warn}>Owner-only controls.</div>}
            <label style={S.lbl}>Market Volatility Flag</label>
            <div style={S.r3}>
              {["Normal","Elevated","Extreme"].map((l,i)=>(
                <button key={i} style={{...S.btn(["#10b981","#f59e0b","#ef4444"][i],!isOwner||loading),fontSize:10,padding:"5px 3px"}}
                  onClick={()=>doVolatility(i)} disabled={!isOwner||loading}>{l}</button>
              ))}
            </div>
            <div style={S.sep}/>
            <label style={S.lbl}>Validator Address</label>
            <input style={S.inp} value={compTarget} onChange={e=>setCompTarget(e.target.value)} placeholder="0x..."/>
            <label style={{...S.lbl,marginTop:6}}>Compliance Level</label>
            <select style={S.sel} value={compLevel} onChange={e=>setCompLevel(e.target.value)}>
              {COMPLIANCE_LABEL.map((l,i)=><option key={i} value={i}>{l}</option>)}
            </select>
            <button style={S.btn("#f59e0b",loading||!isOwner)} onClick={doCompliance} disabled={loading||!isOwner}>
              Set Compliance Level
            </button>
          </div>
        </div>

        {/* ═══ RIGHT ═══ */}
        <div style={S.right}>

          {/* Trade panel */}
          <div style={S.card}>
            <div style={S.ct}>📈 Trade Simulator</div>
            <div style={S.info}>
              Latency tracked automatically in blocks. Fast verification → R_latency ↑ &nbsp;|&nbsp; Same trader too often → R_integrity ↓ (collusion) &nbsp;|&nbsp; Malicious → SLASH
            </div>
            <div style={S.r2}>
              <div>
                <div style={{fontWeight:700,fontSize:11,color:"#e2e8f0",marginBottom:5}}>① Select Validator</div>
                <div style={{fontSize:10,color:"#64748b",marginBottom:5}}>
                  Current: {currentVal&&currentVal!==ethers.ZeroAddress
                    ?<span style={{color:"#10b981",fontWeight:700}}>{short(currentVal)}</span>
                    :<span style={{color:"#ef4444"}}>None selected</span>}
                </div>
                <button style={S.btn("#10b981",loading||!account)} onClick={doSelect} disabled={loading||!account}>⭐ Select Validator</button>
              </div>
              <div style={{borderLeft:"1px solid #334155",paddingLeft:12}}>
                <div style={{fontWeight:700,fontSize:11,color:"#e2e8f0",marginBottom:5}}>② Submit Trade</div>
                <div style={S.r2}>
                  <div><label style={S.lbl}>Ticker</label><input style={S.inp} value={ticker} onChange={e=>setTicker(e.target.value)}/></div>
                  <div><label style={S.lbl}>Sector</label>
                    <select style={S.sel} value={sector} onChange={e=>setSector(e.target.value)}>
                      {SECTORS.map(s=><option key={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
                <div style={S.r2}>
                  <div><label style={S.lbl}>Qty</label><input style={S.inp} type="number" min="1" value={tradeQty} onChange={e=>setTradeQty(e.target.value)}/></div>
                  <div><label style={S.lbl}>ETH (escrow)</label><input style={S.inp} value={tradeVal} onChange={e=>setTradeVal(e.target.value)}/></div>
                </div>
                <button style={S.btn("#0ea5e9",loading||!account||!currentVal||currentVal===ethers.ZeroAddress)}
                  onClick={doSubmit} disabled={loading||!account||!currentVal||currentVal===ethers.ZeroAddress}>📤 Submit Trade</button>
              </div>
            </div>
            <div style={S.sep}/>
            <div style={{fontWeight:700,fontSize:11,color:"#38bdf8",marginBottom:7}}>③ Verify Trade (current validator only)</div>
            {isValidator
              ?<div style={S.info}>✅ You are the current validator.</div>
              :currentVal&&currentVal!==ethers.ZeroAddress&&account
              ?<div style={S.warn}>⚠️ Switch MetaMask to {short(currentVal)} to verify.</div>
              :null}
            <div style={S.r3}>
              <div><label style={S.lbl}>Trade ID</label><input style={S.inp} value={tradeId} onChange={e=>setTradeId(e.target.value)} placeholder="e.g. 1"/></div>
              <div><label style={S.lbl}>Outcome</label>
                <select style={S.sel} value={String(verifyOk)} onChange={e=>setVerifyOk(e.target.value==="true")}>
                  <option value="true">✅ Success (+rep)</option>
                  <option value="false">❌ Failure (−rep)</option>
                </select>
              </div>
              <div><label style={S.lbl}>Severity</label>
                <select style={S.sel} value={severity} onChange={e=>setSeverity(e.target.value)} disabled={verifyOk}>
                  <option value="0">None (−5)</option>
                  <option value="1">Lazy (−3)</option>
                  <option value="2">⚡ Malicious (SLASH)</option>
                </select>
              </div>
            </div>
            <button style={S.btn("#ef4444",loading||!account||!isValidator)} onClick={doVerify} disabled={loading||!account||!isValidator}>
              ⚡ Verify Trade — updates all 5 sub-scores live
            </button>
          </div>

          {/* Tabs */}
          <div style={S.card}>
            <div style={S.tbbar}>
              {[["leaderboard","🏆 Leaderboard"],["subscores","📊 Sub-Scores"],["trades","📋 Trades"],["events","📡 Events"]].map(([id,lbl])=>(
                <button key={id} style={S.tb(tab===id)} onClick={()=>setTab(id)}>{lbl}</button>
              ))}
            </div>

            {tab==="leaderboard"&&(
              <table style={S.tbl}>
                <thead><tr>{["Address","Stake","Rep","W","✓","✗","Verif","Compliance","Status"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {validators.length===0
                    ?<tr><td colSpan={9} style={{...S.td,color:"#475569",textAlign:"center",padding:16}}>No validators yet — stake ETH to register</td></tr>
                    :validators.map(v=>(
                      <tr key={v.addr} style={{background:v.addr.toLowerCase()===currentVal.toLowerCase()?"#052e16":"transparent"}}>
                        <td style={S.td}>
                          {v.addr.toLowerCase()===currentVal.toLowerCase()&&"⭐ "}
                          {v.addr.toLowerCase()===account.toLowerCase()&&"👤 "}
                          <span style={{fontFamily:"monospace"}}>{short(v.addr)}</span>
                          {Number(v.collusionFlags)>0&&<span style={{...S.bdg("#ef4444"),marginLeft:3}}>🚩</span>}
                        </td>
                        <td style={S.td}>{fmtEth(v.stake)}</td>
                        <td style={{...S.td,color:"#10b981",fontWeight:700,fontSize:13}}>{String(v.compositeRep)}</td>
                        <td style={{...S.td,color:"#f59e0b",fontWeight:700,fontSize:13}}>{String(v.weight)}</td>
                        <td style={{...S.td,color:"#10b981"}}>{String(v.sucStreak)}</td>
                        <td style={{...S.td,color:"#ef4444"}}>{String(v.failStreak)}</td>
                        <td style={S.td}>{String(v.totalVerif)}</td>
                        <td style={S.td}><span style={S.bdg(COMPLIANCE_COLOR[v.compliance])}>{COMPLIANCE_LABEL[v.compliance]}</span></td>
                        <td style={S.td}>{v.isSlashed?<span style={S.bdg("#ef4444")}>SLASHED</span>:v.isActive?<span style={S.bdg("#10b981")}>ACTIVE</span>:<span style={S.bdg("#94a3b8")}>INACTIVE</span>}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}

            {tab==="subscores"&&(
              <>
                <div style={{...S.info,fontSize:10,marginBottom:8}}>R = 0.35·R_acc + 0.25·R_lat + 0.25·R_intg + 0.10·R_comp + 0.05·R_cons</div>
                <table style={S.tbl}>
                  <thead><tr>{["Validator","R_acc","R_lat","R_intg","R_comp","R_cons","Composite"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {validators.map(v=>{
                      const c=(0.35*Number(v.R_acc)+0.25*Number(v.R_lat)+0.25*Number(v.R_intg)+0.10*Number(v.R_comp)+0.05*Number(v.R_cons)).toFixed(1);
                      return (
                        <tr key={v.addr}>
                          <td style={{...S.td,fontFamily:"monospace"}}>{short(v.addr)}</td>
                          {[[v.R_acc,"#10b981"],[v.R_lat,"#0ea5e9"],[v.R_intg,"#8b5cf6"],[v.R_comp,"#f59e0b"],[v.R_cons,"#64748b"]].map(([sc,co],i)=>{
                            const n=Math.max(0,Math.min(100,Number(sc)));
                            return <td key={i} style={S.td}>
                              <div style={{display:"flex",alignItems:"center",gap:4}}>
                                <div style={{width:34,background:"#0f172a",borderRadius:2,height:4}}>
                                  <div style={{width:`${n}%`,height:"100%",background:co,borderRadius:2}}/>
                                </div>
                                <span style={{color:co,fontWeight:700}}>{String(sc)}</span>
                              </div>
                            </td>;
                          })}
                          <td style={{...S.td,color:"#38bdf8",fontWeight:700}}>{c}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}

            {tab==="trades"&&(
              <table style={S.tbl}>
                <thead><tr>{["ID","Ticker","Sector","ETH","Latency","Status","Validator"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {trades.length===0
                    ?<tr><td colSpan={7} style={{...S.td,color:"#475569",textAlign:"center"}}>No trades yet</td></tr>
                    :trades.map((t,i)=>(
                      <tr key={i} style={{cursor:"pointer"}} onClick={()=>setTradeId(String(t[0]))}>
                        <td style={{...S.td,color:"#38bdf8",fontWeight:700}}>#{String(t[0])}</td>
                        <td style={S.td}>{t[2]}</td>
                        <td style={S.td}>{t[3]}</td>
                        <td style={S.td}>{fmtEth(t[4])}</td>
                        <td style={{...S.td,color:Number(t[11])<=2?"#10b981":Number(t[11])<=15?"#f59e0b":"#ef4444"}}>
                          {t[6]?`${String(t[11])} blks`:"—"}
                        </td>
                        <td style={S.td}>{!t[6]?<span style={S.bdg("#f59e0b")}>PENDING</span>:t[7]?<span style={S.bdg("#10b981")}>✓ OK</span>:<span style={S.bdg("#ef4444")}>✗ FAIL</span>}</td>
                        <td style={{...S.td,fontFamily:"monospace"}}>{short(t[8])}</td>
                      </tr>
                    ))}
                </tbody>
                <tfoot><tr><td colSpan={7} style={{...S.td,color:"#334155",fontSize:9}}>💡 Click row to auto-fill Trade ID</td></tr></tfoot>
              </table>
            )}

            {tab==="events"&&(
              <div style={S.elog}>
                {events.length===0
                  ?<div style={{color:"#1e293b"}}>No events yet. Actions appear here in real time.</div>
                  :events.map((e,i)=>(
                    <div key={i} style={{color:e.includes("SLASHED")||e.includes("❌")||e.includes("COLLUSION")?"#ef4444":e.includes("✅")?"#10b981":e.includes("⭐")?"#f59e0b":e.includes("Sub-scores")?"#8b5cf6":"#64748b",marginBottom:2}}>
                      {e}
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

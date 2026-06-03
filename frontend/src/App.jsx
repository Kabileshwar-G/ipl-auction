import { useState, useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";
import { PLAYERS, TEAMS, getNextBidAmount, formatAmount } from "./data/players";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";

// ── helpers ──────────────────────────────────────────────────────────────────
const teamStyle = (team) => ({ background: team?.color || "#1a1a2e", color: team?.accent || "#gold" });
const roleIcon = (r) => ({ Batsman:"🏏", Bowler:"⚡", "All-Rounder":"🌟", "Wicket Keeper":"🧤" }[r] || "🏏");
const flagEmoji = (c) => ({ India:"🇮🇳", Australia:"🇦🇺", England:"🏴󠁧󠁢󠁥󠁮󠁧󠁿", "South Africa":"🇿🇦", "New Zealand":"🇳🇿", "West Indies":"🏝️", Afghanistan:"🇦🇫", "Sri Lanka":"🇱🇰", Bangladesh:"🇧🇩", Zimbabwe:"🇿🇼", Pakistan:"🇵🇰", Singapore:"🇸🇬", Scotland:"🏴󠁧󠁢󠁳󠁣󠁴󠁿" }[c] || "🌍");

// ── MATCH ENGINE ─────────────────────────────────────────────────────────────
function simulateMatch(team1, team2) {
  const avgRating = (t) => t.players.length ? t.players.reduce((a,p)=>a+p.rating,0)/t.players.length : 70;
  const r1 = avgRating(team1) + (Math.random()*20-10);
  const r2 = avgRating(team2) + (Math.random()*20-10);
  const totalRuns1 = Math.floor(130 + r1*0.8 + Math.random()*40);
  const totalRuns2 = Math.floor(130 + r2*0.8 + Math.random()*40);
  const winner = totalRuns1 > totalRuns2 ? team1 : team2;
  const loser = totalRuns1 > totalRuns2 ? team2 : team1;
  const margin = Math.abs(totalRuns1 - totalRuns2);
  const nrr = ((totalRuns1/20)-(totalRuns2/20)).toFixed(3);
  return { team1Id: team1.id, team2Id: team2.id, score1: totalRuns1, score2: totalRuns2, winnerId: winner.id, loserId: loser.id, margin, nrr: parseFloat(nrr) };
}

function runFullSeason(teams) {
  const results = [];
  const ids = teams.map(t=>t.id);
  for(let i=0;i<ids.length;i++) for(let j=i+1;j<ids.length;j++) {
    const t1=teams.find(t=>t.id===ids[i]), t2=teams.find(t=>t.id===ids[j]);
    if(t1&&t2) results.push(simulateMatch(t1,t2));
  }
  return results;
}

function buildPointsTable(teams, matches) {
  const table = {};
  teams.forEach(t => { table[t.id]={id:t.id,name:t.name,shortName:t.shortName,color:t.color,played:0,won:0,lost:0,pts:0,nrr:0,nrrSum:0}; });
  matches.forEach(m => {
    if(table[m.winnerId]) { table[m.winnerId].won++; table[m.winnerId].pts+=2; table[m.winnerId].nrrSum+=Math.abs(m.nrr); }
    if(table[m.loserId]) { table[m.loserId].lost++; }
    if(table[m.team1Id]) table[m.team1Id].played++;
    if(table[m.team2Id]) table[m.team2Id].played++;
  });
  return Object.values(table).map(t=>({...t,nrr:(t.nrrSum/(t.played||1)).toFixed(3)})).sort((a,b)=>b.pts-a.pts||(b.nrr-a.nrr));
}

// ────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [screen, setScreen] = useState("home"); // home | lobby | auction | squads | season
  const [socket, setSocket] = useState(null);
  const [roomCode, setRoomCode] = useState("");
  const [inputCode, setInputCode] = useState("");
  const [userName, setUserName] = useState("");
  const [userId, setUserId] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [room, setRoom] = useState(null);
  const [myTeamId, setMyTeamId] = useState(null);
  const [error, setError] = useState("");
  const [purseChoice, setPurseChoice] = useState(12000);

  // auction state
  const [currentPlayer, setCurrentPlayer] = useState(null);
  const [currentBid, setCurrentBid] = useState(0);
  const [highestBidder, setHighestBidder] = useState(null);
  const [highestBidderName, setHighestBidderName] = useState("");
  const [bidHistory, setBidHistory] = useState([]);
  const [log, setLog] = useState([]);
  const [timeLeft, setTimeLeft] = useState(15);
  const [soldPlayers, setSoldPlayers] = useState([]);
  const [teams, setTeams] = useState([]);
  const [playerQueue, setPlayerQueue] = useState([]);
  const [auctionDone, setAuctionDone] = useState(false);
  const [suggestedPlayer, setSuggestedPlayer] = useState(null);
  const [auctionStarted, setAuctionStarted] = useState(false);
  const [activeFilter, setActiveFilter] = useState("All");

  // season
  const [seasonMatches, setSeasonMatches] = useState([]);
  const [pointsTable, setPointsTable] = useState([]);
  const [champion, setChampion] = useState(null);
  const [seasonView, setSeasonView] = useState("table"); // table | fixtures | stats

  const socketRef = useRef(null);

  useEffect(() => {
    const sock = io(BACKEND_URL, { transports: ["websocket","polling"] });
    socketRef.current = sock;
    setSocket(sock);

    sock.on("room_created", ({ code, settings }) => {
      setRoomCode(code);
      setIsAdmin(true);
      setScreen("lobby");
    });
    sock.on("joined_room", ({ room: r, userId: uid }) => {
      setUserId(uid);
      setRoom(r);
      setTeams(r.teams || []);
      setLog(r.log || []);
      setScreen("lobby");
    });
    sock.on("user_joined", ({ users, teams: t, log: l }) => {
      setRoom(prev => prev ? {...prev, users} : null);
      setTeams(t);
      if(l?.length) setLog(l);
    });
    sock.on("teams_updated", ({ teams: t, users, log: l }) => {
      setTeams(t);
      setRoom(prev => prev ? {...prev, users} : null);
      if(l?.length) setLog(l);
    });
    sock.on("auction_started", ({ teams: t, playerQueue: pq, log: l }) => {
      setTeams(t); setPlayerQueue(pq); setLog(l); setAuctionStarted(true); setScreen("auction");
    });
    sock.on("suggest_nominate", ({ player }) => setSuggestedPlayer(player));
    sock.on("player_nominated", ({ player, currentBid: cb, log: l }) => {
      setCurrentPlayer(player); setCurrentBid(cb); setHighestBidder(null);
      setHighestBidderName(""); setBidHistory([]); setTimeLeft(15);
      if(l?.length) setLog(l);
    });
    sock.on("bid_update", ({ currentBid: cb, highestBidder: hb, highestBidderName: hbn, bidHistory: bh, log: l, timeLeft: tl }) => {
      setCurrentBid(cb); setHighestBidder(hb); setHighestBidderName(hbn);
      setBidHistory(bh); setTimeLeft(tl);
      if(l?.length) setLog(l);
    });
    sock.on("timer_tick", ({ timeLeft: tl }) => setTimeLeft(tl));
    sock.on("player_sold", ({ teams: t, log: l, soldPlayers: sp }) => {
      setTeams(t); if(l?.length) setLog(l); setSoldPlayers(sp||[]);
      setCurrentPlayer(null); setCurrentBid(0); setHighestBidder(null);
    });
    sock.on("auction_complete", ({ teams: t, soldPlayers: sp, log: l }) => {
      setTeams(t); setSoldPlayers(sp||[]); if(l?.length) setLog(l);
      setAuctionDone(true);
    });
    sock.on("error", ({ message }) => setError(message));
    return () => sock.disconnect();
  }, []);

  const createRoom = () => {
    if (!userName.trim()) return setError("Enter your name!");
    socketRef.current.emit("create_room", { adminName: userName, purse: purseChoice });
    setUserId(socketRef.current.id);
  };

  const joinRoom = () => {
    if (!userName.trim() || !inputCode.trim()) return setError("Enter name and room code!");
    socketRef.current.emit("join_room", { code: inputCode.toUpperCase(), userName });
    setRoomCode(inputCode.toUpperCase());
  };

  const selectTeam = (team) => {
    socketRef.current.emit("select_team", { code: roomCode, teamId: team.id, teamData: { name: team.name, shortName: team.shortName, color: team.color, accent: team.accent } });
    setMyTeamId(team.id);
  };

  const startAuction = () => {
    const shuffled = [...PLAYERS].sort(() => Math.random()-0.5);
    socketRef.current.emit("start_auction", { code: roomCode, playerQueue: shuffled });
  };

  const nominatePlayer = (player) => {
    socketRef.current.emit("nominate_player", { code: roomCode, player });
    setSuggestedPlayer(null);
  };

  const placeBid = () => {
    if (!myTeamId) return setError("You haven't selected a team!");
    const myTeam = teams.find(t => t.id === myTeamId);
    if (!myTeam) return;
    const nextBid = getNextBidAmount(currentBid);
    if (nextBid > myTeam.purseRemaining) return setError("Insufficient purse!");
    socketRef.current.emit("place_bid", { code: roomCode, teamId: myTeamId, amount: nextBid });
  };

  const runSeason = () => {
    const matches = runFullSeason(teams);
    const table = buildPointsTable(teams, matches);
    // Playoffs
    const top4 = table.slice(0, 4);
    const q1 = simulateMatch(teams.find(t=>t.id===top4[0].id), teams.find(t=>t.id===top4[1].id));
    const elim = simulateMatch(teams.find(t=>t.id===top4[2].id), teams.find(t=>t.id===top4[3].id));
    const q1Loser = teams.find(t=>t.id===q1.loserId);
    const elimWinner = teams.find(t=>t.id===elim.winnerId);
    const q2 = simulateMatch(q1Loser, elimWinner);
    const finalist1 = teams.find(t=>t.id===q1.winnerId);
    const finalist2 = teams.find(t=>t.id===q2.winnerId);
    const final = simulateMatch(finalist1, finalist2);
    const champ = teams.find(t=>t.id===final.winnerId);
    setSeasonMatches(matches);
    setPointsTable(table);
    setChampion(champ);
    setScreen("season");
  };

  const myTeam = teams.find(t => t.id === myTeamId);
  const takenTeamIds = teams.filter(t=>!t.isAI).map(t=>t.id);
  const nextBidAmt = getNextBidAmount(currentBid);

  // ── SCREENS ─────────────────────────────────────────────────────────────────

  if (screen === "home") return (
    <div style={{minHeight:"100vh",background:"#0a0a1a",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Rajdhani',sans-serif",padding:"20px"}}>
      <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Bebas+Neue&display=swap" rel="stylesheet"/>
      <div style={{width:"100%",maxWidth:480,textAlign:"center"}}>
        <div style={{fontSize:72,marginBottom:8}}>🏏</div>
        <h1 style={{fontFamily:"'Bebas Neue'",fontSize:52,color:"#FFD700",margin:"0 0 4px",letterSpacing:3}}>IPL AUCTION</h1>
        <p style={{color:"#888",fontSize:16,marginBottom:40}}>Multiplayer • Real-time • 10 Teams • 120+ Players</p>
        {error && <div style={{background:"#FF4444",color:"#fff",padding:"10px 16px",borderRadius:8,marginBottom:16,fontSize:14}}>{error} <span style={{cursor:"pointer",marginLeft:8}} onClick={()=>setError("")}>✕</span></div>}
        <input placeholder="Your Name" value={userName} onChange={e=>setUserName(e.target.value)}
          style={{width:"100%",padding:"14px 16px",borderRadius:10,border:"1px solid #333",background:"#111",color:"#fff",fontSize:16,marginBottom:16,boxSizing:"border-box"}}/>
        <div style={{display:"flex",gap:12,marginBottom:24}}>
          <select value={purseChoice} onChange={e=>setPurseChoice(Number(e.target.value))}
            style={{flex:1,padding:"14px",borderRadius:10,border:"1px solid #333",background:"#111",color:"#fff",fontSize:14}}>
            <option value={10000}>₹100 Cr purse</option>
            <option value={12000}>₹120 Cr purse</option>
            <option value={15000}>₹150 Cr purse</option>
          </select>
        </div>
        <button onClick={createRoom}
          style={{width:"100%",padding:"16px",background:"#FFD700",color:"#000",fontFamily:"'Bebas Neue'",fontSize:22,letterSpacing:2,borderRadius:10,border:"none",cursor:"pointer",marginBottom:12}}>
          CREATE ROOM
        </button>
        <div style={{display:"flex",gap:10}}>
          <input placeholder="Room Code" value={inputCode} onChange={e=>setInputCode(e.target.value.toUpperCase())}
            style={{flex:1,padding:"14px",borderRadius:10,border:"1px solid #333",background:"#111",color:"#fff",fontSize:16,letterSpacing:3}}/>
          <button onClick={joinRoom}
            style={{padding:"14px 20px",background:"#1a3a6b",color:"#FFD700",fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:1,borderRadius:10,border:"1px solid #1e5ab0",cursor:"pointer"}}>
            JOIN
          </button>
        </div>
        <p style={{color:"#444",fontSize:13,marginTop:20}}>Share room code with friends • Up to 10 players • AI fills empty teams</p>
      </div>
    </div>
  );

  if (screen === "lobby") return (
    <div style={{minHeight:"100vh",background:"#0a0a1a",fontFamily:"'Rajdhani',sans-serif",padding:"20px"}}>
      <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Bebas+Neue&display=swap" rel="stylesheet"/>
      <div style={{maxWidth:900,margin:"0 auto"}}>
        <div style={{textAlign:"center",marginBottom:30}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:12,background:"#111",border:"1px solid #333",borderRadius:12,padding:"12px 24px"}}>
            <span style={{color:"#888",fontSize:14}}>ROOM CODE</span>
            <span style={{fontFamily:"'Bebas Neue'",fontSize:32,color:"#FFD700",letterSpacing:6}}>{roomCode}</span>
            <button onClick={()=>navigator.clipboard.writeText(roomCode)} style={{padding:"6px 12px",background:"#222",border:"1px solid #444",borderRadius:6,color:"#aaa",cursor:"pointer",fontSize:12}}>Copy</button>
          </div>
          {isAdmin && <p style={{color:"#888",fontSize:13,margin:"8px 0"}}>Share this code with friends to join</p>}
        </div>
        {error && <div style={{background:"#FF4444",color:"#fff",padding:"10px 16px",borderRadius:8,marginBottom:16,fontSize:14,textAlign:"center"}}>{error}</div>}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:12,marginBottom:30}}>
          {TEAMS.map(team => {
            const taken = takenTeamIds.includes(team.id);
            const isMine = myTeamId === team.id;
            const owner = room?.users?.find(u=>u.teamId===team.id);
            return (
              <div key={team.id} onClick={()=>!taken && selectTeam(team)}
                style={{background:isMine?"#1a1a1a":taken?"#111":"#111",border:`2px solid ${isMine?team.color:taken?"#222":"#222"}`,
                  borderRadius:12,padding:"16px 12px",textAlign:"center",cursor:taken&&!isMine?"not-allowed":"pointer",
                  opacity:taken&&!isMine?0.5:1,transition:"all 0.2s"}}>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:28,color:team.color,letterSpacing:1}}>{team.shortName}</div>
                <div style={{color:"#888",fontSize:11,marginBottom:8}}>{team.name}</div>
                {isMine && <div style={{background:team.color,color:"#fff",fontSize:11,borderRadius:6,padding:"2px 8px",fontWeight:600}}>YOUR TEAM</div>}
                {taken && !isMine && <div style={{color:"#666",fontSize:11}}>{owner?.name || "Taken"}</div>}
                {!taken && <div style={{color:"#444",fontSize:11}}>Available</div>}
              </div>
            );
          })}
        </div>
        <div style={{background:"#111",border:"1px solid #222",borderRadius:12,padding:"16px",marginBottom:20}}>
          <div style={{color:"#888",fontSize:12,marginBottom:8}}>PLAYERS IN ROOM</div>
          <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
            {room?.users?.map(u=>(
              <div key={u.id} style={{background:"#1a1a1a",border:"1px solid #333",borderRadius:8,padding:"6px 14px",color:u.id===userId?"#FFD700":"#ccc",fontSize:14}}>
                {u.name} {u.teamId && <span style={{color:"#666",fontSize:12}}>({u.teamId})</span>}
              </div>
            ))}
          </div>
        </div>
        {isAdmin && (
          <div style={{textAlign:"center"}}>
            <button onClick={startAuction} disabled={!myTeamId}
              style={{padding:"16px 48px",background:myTeamId?"#FFD700":"#333",color:myTeamId?"#000":"#666",
                fontFamily:"'Bebas Neue'",fontSize:24,letterSpacing:2,borderRadius:10,border:"none",cursor:myTeamId?"pointer":"not-allowed"}}>
              START AUCTION
            </button>
            {!myTeamId && <p style={{color:"#666",fontSize:13,marginTop:8}}>Select a team first</p>}
          </div>
        )}
        {!isAdmin && !myTeamId && <p style={{textAlign:"center",color:"#888"}}>Select a team and wait for the admin to start</p>}
        {!isAdmin && myTeamId && <p style={{textAlign:"center",color:"#888"}}>Waiting for admin to start auction...</p>}
      </div>
    </div>
  );

  if (screen === "auction") {
    const myTeam = teams.find(t=>t.id===myTeamId);
    const roles = ["All","Batsman","Bowler","All-Rounder","Wicket Keeper"];
    const filteredQueue = activeFilter==="All"?playerQueue:playerQueue.filter(p=>p.role===activeFilter);
    return (
      <div style={{minHeight:"100vh",background:"#0a0a1a",fontFamily:"'Rajdhani',sans-serif",color:"#fff"}}>
        <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Bebas+Neue&display=swap" rel="stylesheet"/>
        {/* Header */}
        <div style={{background:"#0d0d1f",borderBottom:"1px solid #222",padding:"10px 20px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <span style={{fontFamily:"'Bebas Neue'",fontSize:24,color:"#FFD700",letterSpacing:2}}>IPL AUCTION</span>
            <span style={{background:"#1a3a1a",color:"#4CAF50",fontSize:12,padding:"3px 10px",borderRadius:20,border:"1px solid #2a4a2a"}}>🔴 LIVE</span>
            <span style={{background:"#222",color:"#888",fontSize:12,padding:"3px 10px",borderRadius:20"}}>ROOM: {roomCode}</span>
          </div>
          {myTeam && (
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <div style={{background:"#111",border:`1px solid ${myTeam.color}`,borderRadius:8,padding:"6px 14px",textAlign:"right"}}>
                <div style={{fontSize:11,color:"#888"}}>MY TEAM</div>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:myTeam.color}}>{myTeam.shortName}</div>
              </div>
              <div style={{background:"#111",border:"1px solid #333",borderRadius:8,padding:"6px 14px",textAlign:"right"}}>
                <div style={{fontSize:11,color:"#888"}}>PURSE</div>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#FFD700"}}>{formatAmount(myTeam.purseRemaining)}</div>
              </div>
            </div>
          )}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"280px 1fr 280px",gap:0,height:"calc(100vh - 53px)"}}>
          {/* Left: Teams */}
          <div style={{borderRight:"1px solid #1a1a2e",overflowY:"auto",padding:"12px"}}>
            <div style={{color:"#888",fontSize:11,fontWeight:600,marginBottom:10,letterSpacing:1}}>ALL TEAMS</div>
            {teams.map(t=>(
              <div key={t.id} style={{background:"#111",border:`1px solid ${t.id===myTeamId?t.color:"#1e1e2e"}`,borderRadius:8,padding:"10px",marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:t.color}}>{t.shortName}</div>
                  {t.isAI && <span style={{background:"#1a1a2e",color:"#666",fontSize:10,padding:"2px 6px",borderRadius:4}}>AI</span>}
                  {t.id===highestBidder && <span style={{background:"#1a3a1a",color:"#4CAF50",fontSize:10,padding:"2px 6px",borderRadius:4}}>WINNING</span>}
                </div>
                <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
                  <span style={{fontSize:12,color:"#888"}}>{t.players?.length||0} players</span>
                  <span style={{fontSize:12,color:"#FFD700",fontWeight:600}}>{formatAmount(t.purseRemaining)}</span>
                </div>
                <div style={{background:"#1a1a1a",borderRadius:4,height:3,marginTop:6}}>
                  <div style={{background:t.color,height:3,borderRadius:4,width:`${Math.min(100,(t.players?.length||0)/25*100)}%`}}/>
                </div>
              </div>
            ))}
          </div>

          {/* Center: Auction */}
          <div style={{display:"flex",flexDirection:"column",overflowY:"auto"}}>
            {currentPlayer ? (
              <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",padding:"20px",gap:16}}>
                {/* Timer */}
                <div style={{display:"flex",alignItems:"center",gap:20}}>
                  <div style={{width:64,height:64,borderRadius:"50%",border:`4px solid ${timeLeft<=5?"#FF4444":timeLeft<=10?"#FFD700":"#4CAF50"}`,
                    display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:28,color:timeLeft<=5?"#FF4444":timeLeft<=10?"#FFD700":"#4CAF50"}}>
                    {timeLeft}
                  </div>
                </div>
                {/* Player Card */}
                <div style={{background:"linear-gradient(135deg,#111 0%,#1a1a2e 100%)",border:"1px solid #2a2a4e",borderRadius:16,padding:"24px",textAlign:"center",minWidth:300,maxWidth:380}}>
                  <div style={{fontSize:56,marginBottom:8}}>{flagEmoji(currentPlayer.country)}</div>
                  <div style={{fontFamily:"'Bebas Neue'",fontSize:32,color:"#fff",letterSpacing:1}}>{currentPlayer.name}</div>
                  <div style={{color:"#888",fontSize:14,marginBottom:12}}>{currentPlayer.country}</div>
                  <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"#1a1a3e",border:"1px solid #2a2a5e",borderRadius:20,padding:"4px 16px",marginBottom:16}}>
                    <span>{roleIcon(currentPlayer.role)}</span>
                    <span style={{color:"#aaa",fontSize:13}}>{currentPlayer.role}</span>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:16}}>
                    {[["BAT",currentPlayer.batting],["BOWL",currentPlayer.bowling],["FIELD",currentPlayer.fielding]].map(([label,val])=>(
                      <div key={label} style={{background:"#0d0d20",borderRadius:8,padding:"8px 4px"}}>
                        <div style={{fontSize:11,color:"#666",marginBottom:2}}>{label}</div>
                        <div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:val>=85?"#FFD700":val>=70?"#4CAF50":"#888"}}>{val}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{fontFamily:"'Bebas Neue'",fontSize:14,color:"#888"}}>BASE PRICE: <span style={{color:"#FFD700"}}>{formatAmount(currentPlayer.basePrice)}</span></div>
                </div>
                {/* Bid Panel */}
                <div style={{background:"#111",border:"1px solid #222",borderRadius:12,padding:"20px",width:"100%",maxWidth:380}}>
                  <div style={{textAlign:"center",marginBottom:12}}>
                    <div style={{fontSize:13,color:"#888"}}>CURRENT BID</div>
                    <div style={{fontFamily:"'Bebas Neue'",fontSize:48,color:"#FFD700",lineHeight:1}}>{formatAmount(currentBid)}</div>
                    {highestBidderName && <div style={{color:"#4CAF50",fontSize:14}}>{highestBidderName}</div>}
                  </div>
                  {myTeam && myTeamId && !myTeam.isAI && (
                    <button onClick={placeBid} disabled={nextBidAmt>myTeam.purseRemaining}
                      style={{width:"100%",padding:"14px",background:nextBidAmt>myTeam.purseRemaining?"#222":"#FFD700",
                        color:nextBidAmt>myTeam.purseRemaining?"#555":"#000",fontFamily:"'Bebas Neue'",fontSize:20,
                        letterSpacing:1,borderRadius:8,border:"none",cursor:nextBidAmt>myTeam.purseRemaining?"not-allowed":"pointer"}}>
                      BID {formatAmount(nextBidAmt)}
                    </button>
                  )}
                  {/* Bid History */}
                  <div style={{marginTop:12,maxHeight:120,overflowY:"auto"}}>
                    {bidHistory.slice(0,8).map((b,i)=>(
                      <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:"1px solid #1a1a1a",fontSize:13}}>
                        <span style={{color:"#888"}}>{b.team}</span>
                        <span style={{color:"#FFD700"}}>{formatAmount(b.amount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:20}}>
                {auctionDone ? (
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:64,marginBottom:16}}>🏆</div>
                    <div style={{fontFamily:"'Bebas Neue'",fontSize:36,color:"#FFD700",marginBottom:8}}>AUCTION COMPLETE!</div>
                    <p style={{color:"#888",marginBottom:24}}>{soldPlayers.length} players sold across all teams</p>
                    <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap"}}>
                      <button onClick={()=>setScreen("squads")} style={{padding:"14px 28px",background:"#1a3a1a",color:"#4CAF50",fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:1,borderRadius:8,border:"1px solid #2a4a2a",cursor:"pointer"}}>VIEW SQUADS</button>
                      <button onClick={runSeason} style={{padding:"14px 28px",background:"#FFD700",color:"#000",fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:1,borderRadius:8,border:"none",cursor:"pointer"}}>SIMULATE SEASON 🏏</button>
                    </div>
                  </div>
                ) : (
                  <div style={{textAlign:"center"}}>
                    {suggestedPlayer && isAdmin ? (
                      <div>
                        <div style={{fontSize:48,marginBottom:8}}>{flagEmoji(suggestedPlayer.country)}</div>
                        <div style={{fontFamily:"'Bebas Neue'",fontSize:28,color:"#fff",marginBottom:4}}>{suggestedPlayer.name}</div>
                        <div style={{color:"#888",fontSize:14,marginBottom:16}}>{suggestedPlayer.country} • {suggestedPlayer.role}</div>
                        <button onClick={()=>nominatePlayer(suggestedPlayer)}
                          style={{padding:"14px 32px",background:"#FFD700",color:"#000",fontFamily:"'Bebas Neue'",fontSize:22,letterSpacing:1,borderRadius:8,border:"none",cursor:"pointer"}}>
                          PUT UP FOR BID
                        </button>
                      </div>
                    ) : (
                      <div>
                        <div style={{fontSize:48,marginBottom:8}}>⏳</div>
                        <p style={{color:"#888",fontSize:16}}>{isAdmin?"Loading next player...":"Waiting for admin to nominate next player..."}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: Log + Queue */}
          <div style={{borderLeft:"1px solid #1a1a2e",display:"flex",flexDirection:"column"}}>
            {/* Auction Log */}
            <div style={{flex:"0 0 auto",borderBottom:"1px solid #1a1a2e",padding:"12px",maxHeight:240,display:"flex",flexDirection:"column"}}>
              <div style={{color:"#888",fontSize:11,fontWeight:600,marginBottom:8,letterSpacing:1}}>AUCTION LOG</div>
              <div style={{overflowY:"auto",flex:1}}>
                {log.map((entry,i)=>(
                  <div key={i} style={{fontSize:12,color:i===0?"#fff":"#666",padding:"3px 0",borderBottom:"1px solid #0d0d1a",lineHeight:1.4}}>{entry}</div>
                ))}
              </div>
            </div>
            {/* Player Queue */}
            <div style={{flex:1,padding:"12px",overflowY:"auto"}}>
              <div style={{color:"#888",fontSize:11,fontWeight:600,marginBottom:8,letterSpacing:1}}>UPCOMING PLAYERS ({playerQueue.length})</div>
              <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
                {["All","Batsman","Bowler","All-Rounder","Wicket Keeper"].map(f=>(
                  <button key={f} onClick={()=>setActiveFilter(f)}
                    style={{padding:"3px 10px",background:activeFilter===f?"#FFD700":"#111",color:activeFilter===f?"#000":"#666",
                      fontSize:11,borderRadius:10,border:"1px solid #222",cursor:"pointer"}}>
                    {f==="All"?f:f==="Wicket Keeper"?"WK":f.slice(0,3)}
                  </button>
                ))}
              </div>
              {filteredQueue.slice(0,30).map((p,i)=>(
                <div key={p.id} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",borderBottom:"1px solid #0d0d1a",cursor:isAdmin?"pointer":"default"}}
                  onClick={()=>isAdmin&&!currentPlayer&&nominatePlayer(p)}>
                  <span style={{color:"#444",fontSize:11,minWidth:18}}>{i+1}</span>
                  <span style={{fontSize:14}}>{flagEmoji(p.country)}</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,color:"#ccc"}}>{p.name}</div>
                    <div style={{fontSize:11,color:"#555"}}>{p.role} • {formatAmount(p.basePrice)}</div>
                  </div>
                  <div style={{fontSize:12,color:"#FFD700",fontWeight:600}}>{p.rating}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "squads") return (
    <div style={{minHeight:"100vh",background:"#0a0a1a",fontFamily:"'Rajdhani',sans-serif",color:"#fff",padding:20}}>
      <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Bebas+Neue&display=swap" rel="stylesheet"/>
      <div style={{maxWidth:1100,margin:"0 auto"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24}}>
          <h1 style={{fontFamily:"'Bebas Neue'",fontSize:36,color:"#FFD700",margin:0,letterSpacing:2}}>TEAM SQUADS</h1>
          <div style={{display:"flex",gap:12}}>
            <button onClick={()=>setScreen("auction")} style={{padding:"10px 20px",background:"#111",color:"#888",fontFamily:"'Bebas Neue'",fontSize:16,borderRadius:8,border:"1px solid #333",cursor:"pointer"}}>← AUCTION</button>
            <button onClick={runSeason} style={{padding:"10px 24px",background:"#FFD700",color:"#000",fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:1,borderRadius:8,border:"none",cursor:"pointer"}}>SIMULATE SEASON 🏏</button>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:16}}>
          {teams.map(team=>(
            <div key={team.id} style={{background:"#111",border:`1px solid ${team.color}33`,borderRadius:12,overflow:"hidden"}}>
              <div style={{background:team.color,padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontFamily:"'Bebas Neue'",fontSize:24,color:"#fff",letterSpacing:1}}>{team.shortName}</div>
                  <div style={{fontSize:12,color:"rgba(255,255,255,0.7)"}}>{team.name}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:11,color:"rgba(255,255,255,0.6)"}}>PURSE LEFT</div>
                  <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:"#fff"}}>{formatAmount(team.purseRemaining)}</div>
                </div>
              </div>
              <div style={{padding:"12px 16px"}}>
                <div style={{display:"flex",gap:12,marginBottom:12,fontSize:12}}>
                  <span style={{color:"#888"}}>{team.players?.length||0} players</span>
                  <span style={{color:"#888"}}>{team.players?.filter(p=>p.country==="India").length||0} Indian</span>
                  <span style={{color:"#888"}}>{team.players?.filter(p=>p.country!=="India").length||0} Overseas</span>
                  {team.isAI && <span style={{color:"#666",marginLeft:"auto"}}>AI</span>}
                </div>
                <div style={{maxHeight:200,overflowY:"auto"}}>
                  {(team.players||[]).map(p=>(
                    <div key={p.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:"1px solid #1a1a1a",fontSize:13}}>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <span>{roleIcon(p.role)}</span>
                        <span style={{color:p.country==="India"?"#ccc":"#aaa"}}>{p.name}</span>
                      </div>
                      <span style={{color:"#FFD700",fontSize:12}}>{formatAmount(p.soldPrice||p.basePrice)}</span>
                    </div>
                  ))}
                  {(!team.players||team.players.length===0) && <div style={{color:"#444",fontSize:13,textAlign:"center",padding:"20px 0"}}>No players bought</div>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  if (screen === "season") return (
    <div style={{minHeight:"100vh",background:"#0a0a1a",fontFamily:"'Rajdhani',sans-serif",color:"#fff",padding:20}}>
      <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Bebas+Neue&display=swap" rel="stylesheet"/>
      <div style={{maxWidth:900,margin:"0 auto"}}>
        {champion && (
          <div style={{textAlign:"center",background:`${champion.color}22`,border:`2px solid ${champion.color}`,borderRadius:16,padding:"24px",marginBottom:24}}>
            <div style={{fontSize:56,marginBottom:8}}>🏆</div>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:14,color:"#888",letterSpacing:3,marginBottom:4}}>IPL CHAMPIONS</div>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:42,color:champion.color,letterSpacing:2}}>{champion.name}</div>
          </div>
        )}
        <div style={{display:"flex",gap:12,marginBottom:20}}>
          {["table","fixtures","stats"].map(v=>(
            <button key={v} onClick={()=>setSeasonView(v)}
              style={{padding:"10px 20px",background:seasonView===v?"#FFD700":"#111",color:seasonView===v?"#000":"#888",
                fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:1,borderRadius:8,border:"1px solid #333",cursor:"pointer"}}>
              {v.toUpperCase()}
            </button>
          ))}
          <button onClick={()=>setScreen("squads")} style={{marginLeft:"auto",padding:"10px 20px",background:"#111",color:"#888",fontFamily:"'Bebas Neue'",fontSize:16,borderRadius:8,border:"1px solid #333",cursor:"pointer"}}>← SQUADS</button>
        </div>
        {seasonView==="table" && (
          <div style={{background:"#111",border:"1px solid #222",borderRadius:12,overflow:"hidden"}}>
            <div style={{display:"grid",gridTemplateColumns:"30px 1fr 50px 50px 50px 60px 60px",gap:0,padding:"10px 16px",background:"#0d0d1f",fontSize:11,color:"#666",letterSpacing:1}}>
              <span>#</span><span>TEAM</span><span style={{textAlign:"center"}}>P</span><span style={{textAlign:"center"}}>W</span><span style={{textAlign:"center"}}>L</span><span style={{textAlign:"center"}}>PTS</span><span style={{textAlign:"center"}}>NRR</span>
            </div>
            {pointsTable.map((row,i)=>(
              <div key={row.id} style={{display:"grid",gridTemplateColumns:"30px 1fr 50px 50px 50px 60px 60px",gap:0,padding:"12px 16px",borderTop:"1px solid #1a1a1a",
                background:i<4?"#0d1a0d":i===0?"#1a1a0d":"transparent"}}>
                <span style={{color:"#666",fontSize:13}}>{i+1}</span>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:row.color,flexShrink:0}}/>
                  <span style={{fontSize:14,color:i<4?"#fff":"#888"}}>{row.shortName||row.name}</span>
                  {i<4&&<span style={{fontSize:10,color:"#4CAF50",marginLeft:4}}>Q</span>}
                </div>
                {[row.played,row.won,row.lost,row.pts].map((v,j)=>(
                  <span key={j} style={{textAlign:"center",fontSize:14,color:j===3?"#FFD700":"#888"}}>{v}</span>
                ))}
                <span style={{textAlign:"center",fontSize:13,color:row.nrr>=0?"#4CAF50":"#FF4444"}}>{row.nrr>=0?"+":""}{row.nrr}</span>
              </div>
            ))}
          </div>
        )}
        {seasonView==="fixtures" && (
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:10}}>
            {seasonMatches.slice(0,45).map((m,i)=>{
              const t1=teams.find(t=>t.id===m.team1Id), t2=teams.find(t=>t.id===m.team2Id);
              if(!t1||!t2) return null;
              return (
                <div key={i} style={{background:"#111",border:"1px solid #1e1e2e",borderRadius:10,padding:"12px 14px"}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <div style={{textAlign:"center"}}>
                      <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:t1.color}}>{t1.shortName}</div>
                      <div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:m.winnerId===t1.id?"#FFD700":"#888"}}>{m.score1}</div>
                    </div>
                    <div style={{color:"#444",fontSize:12}}>VS</div>
                    <div style={{textAlign:"center"}}>
                      <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:t2.color}}>{t2.shortName}</div>
                      <div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:m.winnerId===t2.id?"#FFD700":"#888"}}>{m.score2}</div>
                    </div>
                  </div>
                  <div style={{textAlign:"center",fontSize:11,color:"#4CAF50",marginTop:4}}>
                    {teams.find(t=>t.id===m.winnerId)?.shortName} won by {m.margin} runs
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {seasonView==="stats" && (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
            <div style={{background:"#111",border:"1px solid #FF6B35",borderRadius:12,padding:16}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:"#FF6B35",letterSpacing:1,marginBottom:12}}>🧡 ORANGE CAP — MOST RUNS</div>
              {teams.slice(0,5).sort((a,b)=>(b.players?.reduce((s,p)=>s+p.batting,0)||0)-(a.players?.reduce((s,p)=>s+p.batting,0)||0)).slice(0,5).map((t,i)=>{
                const topBatter = t.players?.sort((a,b)=>b.batting-a.batting)[0];
                if(!topBatter) return null;
                const estRuns = Math.floor(topBatter.batting * 5.2 + Math.random()*100);
                return <div key={t.id} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid #1a1a1a",fontSize:13}}>
                  <span style={{color:"#ccc"}}>{i+1}. {topBatter.name}</span>
                  <div style={{textAlign:"right"}}><span style={{color:"#FF6B35",fontWeight:600}}>{estRuns} runs</span><span style={{color:"#666",fontSize:11,marginLeft:6}}>({t.shortName})</span></div>
                </div>;
              })}
            </div>
            <div style={{background:"#111",border:"1px solid #9B59B6",borderRadius:12,padding:16}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:"#9B59B6",letterSpacing:1,marginBottom:12}}>💜 PURPLE CAP — MOST WICKETS</div>
              {teams.slice(0,5).sort((a,b)=>(b.players?.reduce((s,p)=>s+p.bowling,0)||0)-(a.players?.reduce((s,p)=>s+p.bowling,0)||0)).slice(0,5).map((t,i)=>{
                const topBowler = t.players?.sort((a,b)=>b.bowling-a.bowling)[0];
                if(!topBowler) return null;
                const estWickets = Math.floor(topBowler.bowling * 0.28 + Math.random()*8);
                return <div key={t.id} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid #1a1a1a",fontSize:13}}>
                  <span style={{color:"#ccc"}}>{i+1}. {topBowler.name}</span>
                  <div style={{textAlign:"right"}}><span style={{color:"#9B59B6",fontWeight:600}}>{estWickets} wickets</span><span style={{color:"#666",fontSize:11,marginLeft:6}}>({t.shortName})</span></div>
                </div>;
              })}
            </div>
            <div style={{gridColumn:"1/-1",background:"#111",border:"1px solid #FFD700",borderRadius:12,padding:16}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:"#FFD700",letterSpacing:1,marginBottom:12}}>⭐ MOST EXPENSIVE BUYS</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:8}}>
                {soldPlayers.sort((a,b)=>b.price-a.price).slice(0,8).map(s=>(
                  <div key={s.player.id} style={{background:"#0d0d1a",borderRadius:8,padding:"10px 12px"}}>
                    <div style={{fontSize:13,color:"#fff",fontWeight:500}}>{s.player.name}</div>
                    <div style={{fontSize:11,color:"#888",marginBottom:4}}>{s.team}</div>
                    <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#FFD700"}}>{formatAmount(s.price)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return null;
}

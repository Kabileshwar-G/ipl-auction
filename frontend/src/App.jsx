import { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";
import { PLAYERS, TEAMS, getNextBidAmount, formatAmount } from "./data/players";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";

const roleIcon = r => ({ Batsman:"🏏", Bowler:"⚡", "All-Rounder":"🌟", "Wicket Keeper":"🧤" }[r] || "🏏");
const flagEmoji = c => ({ India:"🇮🇳", Australia:"🇦🇺", England:"🏴󠁧󠁢󠁥󠁮󠁧󠁿", "South Africa":"🇿🇦", "New Zealand":"🇳🇿", "West Indies":"🏝️", Afghanistan:"🇦🇫", "Sri Lanka":"🇱🇰", Bangladesh:"🇧🇩", Zimbabwe:"🇿🇼", Pakistan:"🇵🇰", Ireland:"🍀", Singapore:"🇸🇬" }[c] || "🌍");

// Jersey SVG per team
function JerseyIcon({ team, size = 40 }) {
  if (!team) return null;
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
      <path d="M10 8 L6 18 L12 17 L12 34 L28 34 L28 17 L34 18 L30 8 L24 11 C22 6 18 6 16 11 Z"
        fill={team.color} stroke={team.accent} strokeWidth="1.5"/>
      <text x="20" y="27" textAnchor="middle" fontSize="8" fontWeight="bold"
        fill={team.accent} fontFamily="Arial">{team.shortName}</text>
    </svg>
  );
}

function RatingBar({ value, color = "#FFD700" }) {
  return (
    <div style={{ background: "#1a1a2e", borderRadius: 4, height: 5, width: "100%" }}>
      <div style={{ background: color, width: `${value}%`, height: 5, borderRadius: 4, transition: "width 0.5s" }} />
    </div>
  );
}

// Match simulation
function simulateMatch(t1, t2) {
  const avg = t => t.players?.length ? t.players.reduce((a, p) => a + p.rating, 0) / t.players.length : 70;
  const r1 = avg(t1) + (Math.random() * 20 - 10);
  const r2 = avg(t2) + (Math.random() * 20 - 10);
  const s1 = Math.floor(130 + r1 * 0.8 + Math.random() * 40);
  const s2 = Math.floor(130 + r2 * 0.8 + Math.random() * 40);
  const wId = s1 > s2 ? t1.id : t2.id;
  const lId = s1 > s2 ? t2.id : t1.id;
  return { team1Id: t1.id, team2Id: t2.id, score1: s1, score2: s2, winnerId: wId, loserId: lId, margin: Math.abs(s1 - s2), nrr: parseFloat(((s1 / 20) - (s2 / 20)).toFixed(3)) };
}

function runSeason(teams) {
  const results = [];
  for (let i = 0; i < teams.length; i++)
    for (let j = i + 1; j < teams.length; j++)
      results.push(simulateMatch(teams[i], teams[j]));
  return results;
}

function buildTable(teams, matches) {
  const tbl = {};
  teams.forEach(t => { tbl[t.id] = { ...t, played: 0, won: 0, lost: 0, pts: 0, nrrSum: 0 }; });
  matches.forEach(m => {
    if (tbl[m.team1Id]) tbl[m.team1Id].played++;
    if (tbl[m.team2Id]) tbl[m.team2Id].played++;
    if (tbl[m.winnerId]) { tbl[m.winnerId].won++; tbl[m.winnerId].pts += 2; tbl[m.winnerId].nrrSum += Math.abs(m.nrr); }
    if (tbl[m.loserId]) tbl[m.loserId].lost++;
  });
  return Object.values(tbl)
    .map(t => ({ ...t, nrr: +(t.nrrSum / (t.played || 1)).toFixed(3) }))
    .sort((a, b) => b.pts - a.pts || b.nrr - a.nrr);
}

export default function App() {
  const [screen, setScreen] = useState("home");
  const [room, setRoom] = useState(null);
  const [userId, setUserId] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [roomCode, setRoomCode] = useState("");
  const [inputCode, setInputCode] = useState("");
  const [userName, setUserName] = useState("");
  const [myTeamId, setMyTeamId] = useState(null);
  const [purseChoice, setPurseChoice] = useState(12000);
  const [error, setError] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState([]);
  const [activeTab, setActiveTab] = useState("log"); // log | chat | squads
  const [seasonData, setSeasonData] = useState(null);
  const [seasonView, setSeasonView] = useState("table");
  const [activeFilter, setActiveFilter] = useState("All");
  const [playerFilter, setPlayerFilter] = useState("");

  const socketRef = useRef(null);
  const chatEndRef = useRef(null);
  const logEndRef = useRef(null);

  // Derived from room
  const teams = room?.teams || [];
  const myTeam = teams.find(t => t.id === myTeamId);
  const takenIds = teams.filter(t => !t.isAI).map(t => t.id);
  const currentPlayer = room?.currentPlayer;
  const currentBid = room?.currentBid || 0;
  const highestBidder = room?.highestBidder;
  const nextBid = getNextBidAmount(currentBid);
  // BIDDING LOCK: can't bid again if you're currently winning
  const iAmWinning = highestBidder === myTeamId;
  const canBid = room?.auctionActive && !room?.auctionPaused && !room?.rtmActive &&
    myTeam && !iAmWinning &&
    nextBid <= (myTeam?.purseRemaining || 0) &&
    (myTeam?.players?.length || 0) < 20;

  useEffect(() => {
    const sock = io(BACKEND_URL, { transports: ["websocket", "polling"] });
    socketRef.current = sock;

    sock.on("room_created", ({ code, userId: uid }) => {
      setRoomCode(code); setUserId(uid); setIsAdmin(true); setScreen("lobby");
    });
    sock.on("joined_room", ({ userId: uid }) => {
      setUserId(uid);
      sock.emit("get_room_state");
    });
    sock.on("room_state", r => {
      setRoom(r);
      if (r.auctionStarted && screen === "lobby") setScreen("auction");
      if (r.auctionComplete && screen === "auction") setScreen("done");
    });
    sock.on("timer_tick", ({ timeLeft }) => {
      setRoom(prev => prev ? { ...prev, timeLeft } : null);
    });
    sock.on("chat_message", msg => {
      setChatMessages(prev => [...prev, msg]);
    });
    sock.on("chat_history", msgs => {
      setChatMessages(msgs || []);
    });
    sock.on("join_error", ({ message }) => {
      setError(message);
      setTimeout(() => setError(""), 3000);
    });

    return () => sock.disconnect();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  // Re-request state when auction starts
  useEffect(() => {
    if (room?.auctionStarted && screen === "lobby") setScreen("auction");
    if (room?.auctionComplete) setScreen("done");
  }, [room?.auctionStarted, room?.auctionComplete]);

  const emit = (event, data = {}) => socketRef.current?.emit(event, data);

  const createRoom = () => {
    if (!userName.trim()) return setError("Enter your name!");
    emit("create_room", { adminName: userName.trim(), purse: purseChoice });
    setUserId(socketRef.current?.id);
  };

  const joinRoom = () => {
    if (!userName.trim() || !inputCode.trim()) return setError("Enter name & room code!");
    emit("join_room", { code: inputCode.toUpperCase().trim(), userName: userName.trim() });
    setRoomCode(inputCode.toUpperCase().trim());
  };

  const selectTeam = team => {
    emit("select_team", { teamId: team.id });
    setMyTeamId(team.id);
  };

  const startAuction = () => {
    const shuffled = [...PLAYERS].sort(() => Math.random() - 0.5);
    emit("start_auction", { playerQueue: shuffled });
  };

  const placeBid = () => {
    if (!canBid) return;
    emit("place_bid", { teamId: myTeamId, amount: nextBid });
  };

  const sendChat = () => {
    if (!chatInput.trim()) return;
    emit("chat_message", { message: chatInput.trim() });
    setChatInput("");
  };

  const runSeasonSim = () => {
    const matches = runSeason(teams);
    const table = buildTable(teams, matches);
    const top4 = table.slice(0, 4).map(r => teams.find(t => t.id === r.id)).filter(Boolean);
    const q1 = simulateMatch(top4[0], top4[1]);
    const elim = simulateMatch(top4[2], top4[3]);
    const q2 = simulateMatch(teams.find(t => t.id === q1.loserId), teams.find(t => t.id === elim.winnerId));
    const final = simulateMatch(teams.find(t => t.id === q1.winnerId), teams.find(t => t.id === q2.winnerId));
    const champion = teams.find(t => t.id === final.winnerId);
    setSeasonData({ matches, table, champion, final, q1, q2, elim });
    setScreen("season");
  };

  // ─── HOME ────────────────────────────────────────────────────────────────
  if (screen === "home") return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg,#0a0a1a 0%,#0d1a2a 100%)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Rajdhani',sans-serif", padding: 20 }}>
      <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Bebas+Neue&display=swap" rel="stylesheet" />
      <div style={{ width: "100%", maxWidth: 460, textAlign: "center" }}>
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: "inline-flex", gap: 6 }}>
            {TEAMS.slice(0, 5).map(t => <JerseyIcon key={t.id} team={t} size={36} />)}
          </div>
        </div>
        <h1 style={{ fontFamily: "'Bebas Neue'", fontSize: 56, color: "#FFD700", margin: "0 0 2px", letterSpacing: 4, textShadow: "0 0 30px #FFD70066" }}>IPL AUCTION</h1>
        <p style={{ color: "#555", fontSize: 14, marginBottom: 32 }}>Multiplayer • Live Bidding • 10 Teams • 200+ Players</p>
        {error && <div style={{ background: "#FF444422", border: "1px solid #FF4444", color: "#FF6666", padding: "10px 16px", borderRadius: 8, marginBottom: 14, fontSize: 14 }}>{error}</div>}
        <div style={{ background: "#0d0d1f", border: "1px solid #1e1e3a", borderRadius: 14, padding: 24, marginBottom: 16 }}>
          <input placeholder="Your Name" value={userName} onChange={e => setUserName(e.target.value)} onKeyDown={e => e.key === "Enter" && createRoom()}
            style={{ width: "100%", padding: "13px 16px", borderRadius: 8, border: "1px solid #2a2a4a", background: "#0a0a18", color: "#fff", fontSize: 16, marginBottom: 12, boxSizing: "border-box" }} />
          <select value={purseChoice} onChange={e => setPurseChoice(Number(e.target.value))}
            style={{ width: "100%", padding: "13px 16px", borderRadius: 8, border: "1px solid #2a2a4a", background: "#0a0a18", color: "#fff", fontSize: 14, marginBottom: 16, boxSizing: "border-box" }}>
            <option value={10000}>₹100 Cr purse per team</option>
            <option value={12000}>₹120 Cr purse per team</option>
            <option value={15000}>₹150 Cr purse per team</option>
          </select>
          <button onClick={createRoom}
            style={{ width: "100%", padding: 15, background: "linear-gradient(90deg,#FFD700,#FFA500)", color: "#000", fontFamily: "'Bebas Neue'", fontSize: 22, letterSpacing: 2, borderRadius: 8, border: "none", cursor: "pointer", marginBottom: 10 }}>
            CREATE ROOM
          </button>
          <div style={{ color: "#333", fontSize: 12, margin: "8px 0" }}>— OR JOIN EXISTING —</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input placeholder="6-DIGIT CODE" value={inputCode} onChange={e => setInputCode(e.target.value.toUpperCase())} onKeyDown={e => e.key === "Enter" && joinRoom()}
              style={{ flex: 1, padding: "13px 16px", borderRadius: 8, border: "1px solid #2a2a4a", background: "#0a0a18", color: "#FFD700", fontSize: 18, letterSpacing: 4, fontFamily: "'Bebas Neue'", boxSizing: "border-box" }} />
            <button onClick={joinRoom}
              style={{ padding: "13px 20px", background: "#1a2a4a", color: "#FFD700", fontFamily: "'Bebas Neue'", fontSize: 18, borderRadius: 8, border: "1px solid #2a3a6a", cursor: "pointer" }}>JOIN</button>
          </div>
        </div>
        <p style={{ color: "#333", fontSize: 12 }}>Up to 10 players • No AI bots • Real-time bidding</p>
      </div>
    </div>
  );

  // ─── LOBBY ──────────────────────────────────────────────────────────────
  if (screen === "lobby") return (
    <div style={{ minHeight: "100vh", background: "#0a0a1a", fontFamily: "'Rajdhani',sans-serif", padding: 20 }}>
      <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Bebas+Neue&display=swap" rel="stylesheet" />
      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        {/* Room code banner */}
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 16, background: "#0d0d1f", border: "1px solid #2a2a4a", borderRadius: 12, padding: "14px 28px" }}>
            <span style={{ color: "#555", fontSize: 12, letterSpacing: 2 }}>ROOM CODE</span>
            <span style={{ fontFamily: "'Bebas Neue'", fontSize: 38, color: "#FFD700", letterSpacing: 8 }}>{roomCode}</span>
            <button onClick={() => { navigator.clipboard.writeText(roomCode); }} style={{ padding: "6px 14px", background: "#1a1a2e", border: "1px solid #333", borderRadius: 6, color: "#888", cursor: "pointer", fontSize: 12 }}>Copy</button>
          </div>
          <p style={{ color: "#444", fontSize: 13, marginTop: 6 }}>Share this with friends to join</p>
        </div>
        {error && <div style={{ background: "#FF444422", border: "1px solid #FF4444", color: "#FF6666", padding: "10px 16px", borderRadius: 8, marginBottom: 14, fontSize: 14, textAlign: "center" }}>{error}</div>}
        {/* Team grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(170px,1fr))", gap: 12, marginBottom: 24 }}>
          {TEAMS.map(team => {
            const taken = takenIds.includes(team.id) && myTeamId !== team.id;
            const isMine = myTeamId === team.id;
            const owner = room?.users?.find(u => u.teamId === team.id);
            return (
              <div key={team.id} onClick={() => !taken && selectTeam(team)}
                style={{ background: isMine ? `${team.color}22` : "#0d0d1f", border: `2px solid ${isMine ? team.color : taken ? "#1a1a2e" : "#1e1e3a"}`, borderRadius: 12, padding: "16px 12px", textAlign: "center", cursor: taken ? "not-allowed" : "pointer", opacity: taken ? 0.45 : 1, transition: "all 0.2s" }}>
                <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
                  <JerseyIcon team={team} size={44} />
                </div>
                <div style={{ fontFamily: "'Bebas Neue'", fontSize: 24, color: team.color, letterSpacing: 1 }}>{team.shortName}</div>
                <div style={{ color: "#555", fontSize: 11, marginBottom: 8 }}>{team.name}</div>
                {isMine && <div style={{ background: team.color, color: "#000", fontSize: 11, borderRadius: 20, padding: "3px 10px", fontWeight: 700 }}>YOUR TEAM ✓</div>}
                {taken && !isMine && <div style={{ color: "#555", fontSize: 12 }}>{owner?.name || "Taken"}</div>}
                {!taken && !isMine && <div style={{ color: "#333", fontSize: 11 }}>Select</div>}
              </div>
            );
          })}
        </div>
        {/* Players */}
        <div style={{ background: "#0d0d1f", border: "1px solid #1e1e3a", borderRadius: 12, padding: 14, marginBottom: 16 }}>
          <div style={{ color: "#555", fontSize: 11, letterSpacing: 2, marginBottom: 8 }}>PLAYERS IN ROOM ({room?.users?.length || 0})</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {room?.users?.map(u => {
              const t = teams.find(x => x.id === u.teamId);
              return (
                <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 6, background: "#111", border: `1px solid ${u.id === userId ? "#FFD70066" : "#1e1e2e"}`, borderRadius: 8, padding: "6px 12px" }}>
                  {t && <JerseyIcon team={t} size={18} />}
                  <span style={{ color: u.id === userId ? "#FFD700" : "#aaa", fontSize: 14 }}>{u.name}</span>
                  {u.isAdmin && <span style={{ fontSize: 10, color: "#FFD700" }}>👑</span>}
                </div>
              );
            })}
          </div>
        </div>
        {isAdmin && (
          <div style={{ textAlign: "center" }}>
            <button onClick={startAuction} disabled={!myTeamId}
              style={{ padding: "16px 52px", background: myTeamId ? "linear-gradient(90deg,#FFD700,#FFA500)" : "#1a1a2e", color: myTeamId ? "#000" : "#444", fontFamily: "'Bebas Neue'", fontSize: 26, letterSpacing: 2, borderRadius: 10, border: "none", cursor: myTeamId ? "pointer" : "not-allowed" }}>
              START AUCTION 🏏
            </button>
            {!myTeamId && <p style={{ color: "#555", fontSize: 13, marginTop: 8 }}>Pick a team first</p>}
          </div>
        )}
        {!isAdmin && <p style={{ textAlign: "center", color: "#555", marginTop: 8 }}>{myTeamId ? "✅ Ready! Waiting for host to start..." : "👆 Select a team above"}</p>}
      </div>
    </div>
  );

  // ─── AUCTION ─────────────────────────────────────────────────────────────
  if (screen === "auction") {
    const timeLeft = room?.timeLeft ?? 10;
    const timerColor = timeLeft <= 3 ? "#FF4444" : timeLeft <= 6 ? "#FFD700" : "#4CAF50";
    const bidHistory = room?.bidHistory || [];
    const log = room?.log || [];
    const paused = room?.auctionPaused;
    const rtmActive = room?.rtmActive;
    const myRTM = myTeamId === room?.rtmOriginalTeam;
    const rtmTeam = teams.find(t => t.id === room?.rtmOriginalTeam);
    const roles = ["All", "Batsman", "Bowler", "All-Rounder", "Wicket Keeper"];
    const pQueue = (room?.playerQueue || []).filter(p =>
      (activeFilter === "All" || p.role === activeFilter) &&
      (!playerFilter || p.name.toLowerCase().includes(playerFilter.toLowerCase()))
    );

    return (
      <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#080810", fontFamily: "'Rajdhani',sans-serif", color: "#fff", overflow: "hidden" }}>
        <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Bebas+Neue&display=swap" rel="stylesheet" />

        {/* TOP BAR */}
        <div style={{ background: "#0a0a18", borderBottom: "1px solid #1a1a2e", padding: "8px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontFamily: "'Bebas Neue'", fontSize: 22, color: "#FFD700", letterSpacing: 2 }}>IPL AUCTION</span>
            {paused
              ? <span style={{ background: "#FF444422", color: "#FF6666", fontSize: 11, padding: "3px 10px", borderRadius: 20, border: "1px solid #FF444444" }}>⏸ PAUSED</span>
              : <span style={{ background: "#4CAF5022", color: "#4CAF50", fontSize: 11, padding: "3px 10px", borderRadius: 20, border: "1px solid #4CAF5044" }}>🔴 LIVE</span>
            }
            <span style={{ background: "#111", color: "#555", fontSize: 11, padding: "3px 10px", borderRadius: 20 }}>{roomCode}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {isAdmin && (
              <>
                {!paused
                  ? <button onClick={() => emit("pause_auction")} style={{ padding: "6px 14px", background: "#FF444422", color: "#FF6666", border: "1px solid #FF444444", borderRadius: 6, cursor: "pointer", fontSize: 13, fontFamily: "'Rajdhani'" }}>⏸ Pause</button>
                  : <button onClick={() => emit("resume_auction")} style={{ padding: "6px 14px", background: "#4CAF5022", color: "#4CAF50", border: "1px solid #4CAF5044", borderRadius: 6, cursor: "pointer", fontSize: 13, fontFamily: "'Rajdhani'" }}>▶ Resume</button>
                }
                {room?.auctionActive && !rtmActive &&
                  <button onClick={() => emit("mark_unsold")} style={{ padding: "6px 14px", background: "#FF8C0022", color: "#FF8C00", border: "1px solid #FF8C0044", borderRadius: 6, cursor: "pointer", fontSize: 13, fontFamily: "'Rajdhani'" }}>❌ Unsold</button>
                }
              </>
            )}
            {myTeam && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#0d0d1f", border: `1px solid ${myTeam.color}66`, borderRadius: 8, padding: "5px 12px" }}>
                <JerseyIcon team={myTeam} size={24} />
                <div>
                  <div style={{ fontSize: 10, color: "#555" }}>PURSE</div>
                  <div style={{ fontFamily: "'Bebas Neue'", fontSize: 16, color: "#FFD700" }}>{formatAmount(myTeam.purseRemaining)}</div>
                </div>
                <div style={{ marginLeft: 6 }}>
                  <div style={{ fontSize: 10, color: "#555" }}>SQUAD</div>
                  <div style={{ fontFamily: "'Bebas Neue'", fontSize: 16, color: "#aaa" }}>{myTeam.players?.length || 0}/20</div>
                </div>
                <div style={{ marginLeft: 6 }}>
                  <div style={{ fontSize: 10, color: "#555" }}>RTM</div>
                  <div style={{ fontFamily: "'Bebas Neue'", fontSize: 16, color: "#4CAF50" }}>{myTeam.rtmRemaining ?? 2}</div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* MAIN AREA */}
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "220px 1fr 280px", overflow: "hidden" }}>

          {/* LEFT — Teams */}
          <div style={{ borderRight: "1px solid #1a1a2e", overflowY: "auto", padding: 10 }}>
            <div style={{ color: "#333", fontSize: 10, letterSpacing: 2, marginBottom: 8 }}>TEAMS</div>
            {teams.map(t => {
              const overseas = t.players?.filter(p => p.country !== "India").length || 0;
              const indian = t.players?.filter(p => p.country === "India").length || 0;
              return (
                <div key={t.id} style={{ background: t.id === myTeamId ? `${t.color}18` : "#0d0d1f", border: `1px solid ${t.id === highestBidder ? t.color : t.id === myTeamId ? `${t.color}66` : "#1a1a2e"}`, borderRadius: 8, padding: "8px 10px", marginBottom: 6, cursor: "pointer" }}
                  onClick={() => setActiveTab("squads")}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <JerseyIcon team={t} size={22} />
                      <span style={{ fontFamily: "'Bebas Neue'", fontSize: 18, color: t.color }}>{t.shortName}</span>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      {t.id === highestBidder && <div style={{ fontSize: 9, color: "#4CAF50", fontWeight: 700 }}>WINNING</div>}
                      <div style={{ fontFamily: "'Bebas Neue'", fontSize: 14, color: "#FFD700" }}>{formatAmount(t.purseRemaining)}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#444" }}>
                    <span>{t.players?.length || 0}/20 players</span>
                    <span>🇮🇳{indian} 🌍{overseas}</span>
                  </div>
                  <div style={{ background: "#0a0a14", borderRadius: 3, height: 3, marginTop: 5 }}>
                    <div style={{ background: t.color, height: 3, borderRadius: 3, width: `${Math.min(100, ((t.players?.length || 0) / 20) * 100)}%`, transition: "width 0.4s" }} />
                  </div>
                </div>
              );
            })}
          </div>

          {/* CENTER — Current Player + Bidding */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", overflowY: "auto", padding: "16px 20px", gap: 14 }}>
            {paused && (
              <div style={{ background: "#FF444411", border: "1px solid #FF444433", borderRadius: 10, padding: "12px 24px", textAlign: "center", width: "100%", maxWidth: 400 }}>
                <div style={{ fontSize: 28, marginBottom: 4 }}>⏸️</div>
                <div style={{ fontFamily: "'Bebas Neue'", fontSize: 20, color: "#FF6666", letterSpacing: 1 }}>AUCTION PAUSED</div>
                <div style={{ color: "#555", fontSize: 13 }}>Host will resume shortly</div>
              </div>
            )}

            {/* RTM WINDOW */}
            {rtmActive && (
              <div style={{ background: "#FFD70011", border: "2px solid #FFD70066", borderRadius: 12, padding: "16px 20px", textAlign: "center", width: "100%", maxWidth: 400 }}>
                <div style={{ fontSize: 28, marginBottom: 4 }}>🔄</div>
                <div style={{ fontFamily: "'Bebas Neue'", fontSize: 22, color: "#FFD700", letterSpacing: 1 }}>RTM WINDOW</div>
                <div style={{ color: "#aaa", fontSize: 14, margin: "6px 0" }}>
                  <strong style={{ color: "#fff" }}>{rtmTeam?.name}</strong> can match{" "}
                  <strong style={{ color: "#FFD700" }}>{formatAmount(room?.rtmWinningBid || 0)}</strong> for{" "}
                  <strong style={{ color: "#4CAF50" }}>{room?.rtmPlayer?.name}</strong>
                </div>
                {myRTM && (
                  <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 12 }}>
                    <button onClick={() => emit("use_rtm", { teamId: myTeamId, accept: true })}
                      style={{ padding: "10px 24px", background: "#4CAF50", color: "#000", fontFamily: "'Bebas Neue'", fontSize: 18, borderRadius: 8, border: "none", cursor: "pointer" }}>
                      USE RTM ✓
                    </button>
                    <button onClick={() => emit("use_rtm", { teamId: myTeamId, accept: false })}
                      style={{ padding: "10px 24px", background: "#FF444422", color: "#FF6666", fontFamily: "'Bebas Neue'", fontSize: 18, borderRadius: 8, border: "1px solid #FF444444", cursor: "pointer" }}>
                      DECLINE
                    </button>
                  </div>
                )}
                {!myRTM && <div style={{ color: "#555", fontSize: 13, marginTop: 8 }}>Waiting for {rtmTeam?.name} to decide...</div>}
              </div>
            )}

            {currentPlayer ? (
              <>
                {/* Timer */}
                <div style={{ position: "relative", width: 72, height: 72 }}>
                  <svg width="72" height="72" style={{ transform: "rotate(-90deg)", position: "absolute" }}>
                    <circle cx="36" cy="36" r="30" fill="none" stroke="#1a1a2e" strokeWidth="5" />
                    <circle cx="36" cy="36" r="30" fill="none" stroke={timerColor} strokeWidth="5"
                      strokeDasharray={`${(timeLeft / 10) * 188.4} 188.4`} strokeLinecap="round" style={{ transition: "stroke-dasharray 0.9s linear, stroke 0.3s" }} />
                  </svg>
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Bebas Neue'", fontSize: 28, color: timerColor }}>{paused ? "⏸" : timeLeft}</div>
                </div>

                {/* Player Card */}
                <div style={{ background: "linear-gradient(135deg,#0d0d20 0%,#1a1a30 100%)", border: "1px solid #2a2a4a", borderRadius: 16, padding: "20px 24px", textAlign: "center", width: "100%", maxWidth: 380 }}>
                  <div style={{ fontSize: 52, marginBottom: 6 }}>{flagEmoji(currentPlayer.country)}</div>
                  <div style={{ fontFamily: "'Bebas Neue'", fontSize: 30, color: "#fff", letterSpacing: 1 }}>{currentPlayer.name}</div>
                  <div style={{ color: "#555", fontSize: 13, marginBottom: 10 }}>{currentPlayer.country} · {currentPlayer.age} yrs</div>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#1a1a3a", border: "1px solid #2a2a5a", borderRadius: 20, padding: "4px 14px", marginBottom: 14 }}>
                    <span>{roleIcon(currentPlayer.role)}</span>
                    <span style={{ color: "#aaa", fontSize: 13 }}>{currentPlayer.role}</span>
                    {currentPlayer.isCapped && <span style={{ background: "#FFD70022", color: "#FFD700", fontSize: 10, padding: "1px 7px", borderRadius: 10 }}>CAPPED</span>}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 14 }}>
                    {[["BAT", currentPlayer.batting, "#4CAF50"], ["BOWL", currentPlayer.bowling, "#2196F3"], ["FIELD", currentPlayer.fielding, "#FF9800"]].map(([lbl, val, col]) => (
                      <div key={lbl} style={{ background: "#0a0a18", borderRadius: 8, padding: "8px 4px" }}>
                        <div style={{ fontSize: 10, color: "#444", marginBottom: 3 }}>{lbl}</div>
                        <div style={{ fontFamily: "'Bebas Neue'", fontSize: 24, color: col }}>{val}</div>
                        <RatingBar value={val} color={col} />
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#444" }}>
                    <span>⭐ Rating: <strong style={{ color: "#FFD700" }}>{currentPlayer.rating}</strong></span>
                    <span>IPL: <strong style={{ color: "#aaa" }}>{currentPlayer.iplExp} yrs</strong></span>
                    <span>Base: <strong style={{ color: "#FFD700" }}>{formatAmount(currentPlayer.basePrice)}</strong></span>
                  </div>
                  {currentPlayer.previousTeam && (
                    <div style={{ marginTop: 8, fontSize: 11, color: "#444" }}>
                      Previous team: <span style={{ color: teams.find(t => t.id === currentPlayer.previousTeam)?.color || "#666" }}>{currentPlayer.previousTeam}</span>
                    </div>
                  )}
                </div>

                {/* Bid Panel */}
                <div style={{ background: "#0d0d1f", border: "1px solid #1e1e3a", borderRadius: 12, padding: "18px 20px", width: "100%", maxWidth: 380 }}>
                  <div style={{ textAlign: "center", marginBottom: 14 }}>
                    <div style={{ fontSize: 11, color: "#444", letterSpacing: 2 }}>CURRENT BID</div>
                    <div style={{ fontFamily: "'Bebas Neue'", fontSize: 52, color: "#FFD700", lineHeight: 1.1 }}>{formatAmount(currentBid)}</div>
                    {room?.highestBidderName
                      ? <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                          {teams.find(t => t.id === highestBidder) && <JerseyIcon team={teams.find(t => t.id === highestBidder)} size={18} />}
                          <span style={{ color: "#4CAF50", fontSize: 14, fontWeight: 600 }}>{room.highestBidderName}</span>
                          {iAmWinning && <span style={{ background: "#4CAF5022", color: "#4CAF50", fontSize: 11, padding: "2px 8px", borderRadius: 10 }}>YOU</span>}
                        </div>
                      : <div style={{ color: "#444", fontSize: 13 }}>No bids yet</div>
                    }
                  </div>

                  {myTeam && !myTeam.isAI && (
                    <div style={{ marginBottom: 10 }}>
                      <button onClick={placeBid} disabled={!canBid}
                        style={{ width: "100%", padding: "14px", background: canBid ? "linear-gradient(90deg,#FFD700,#FFA500)" : "#1a1a2e", color: canBid ? "#000" : "#333", fontFamily: "'Bebas Neue'", fontSize: 20, letterSpacing: 1, borderRadius: 8, border: "none", cursor: canBid ? "pointer" : "not-allowed", transition: "all 0.2s" }}>
                        {iAmWinning ? "⏳ WAIT FOR COUNTER BID" : paused ? "⏸ PAUSED" : !canBid && myTeam.players?.length >= 20 ? "SQUAD FULL" : `BID ${formatAmount(nextBid)}`}
                      </button>
                      {iAmWinning && <div style={{ textAlign: "center", color: "#4CAF50", fontSize: 12, marginTop: 6 }}>You're winning — can't bid again until someone outbids you</div>}
                      {!iAmWinning && nextBid > (myTeam?.purseRemaining || 0) && <div style={{ textAlign: "center", color: "#FF6666", fontSize: 12, marginTop: 6 }}>Insufficient purse</div>}
                    </div>
                  )}

                  {/* Bid history */}
                  <div style={{ maxHeight: 110, overflowY: "auto" }}>
                    {bidHistory.slice(0, 8).map((b, i) => {
                      const bt = teams.find(t => t.id === b.teamId);
                      return (
                        <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #0d0d18", fontSize: 13 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                            {bt && <JerseyIcon team={bt} size={16} />}
                            <span style={{ color: i === 0 ? "#fff" : "#555" }}>{b.team}</span>
                          </div>
                          <span style={{ color: i === 0 ? "#FFD700" : "#444", fontFamily: "'Bebas Neue'", fontSize: 15 }}>{formatAmount(b.amount)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : (
              <div style={{ textAlign: "center", padding: 40, color: "#333" }}>
                {room?.auctionComplete
                  ? <div>
                      <div style={{ fontSize: 56, marginBottom: 12 }}>🏆</div>
                      <div style={{ fontFamily: "'Bebas Neue'", fontSize: 32, color: "#FFD700" }}>AUCTION COMPLETE!</div>
                      <p style={{ color: "#555", marginBottom: 20 }}>{room?.soldPlayers?.length || 0} players sold</p>
                      <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                        <button onClick={() => setScreen("done")} style={{ padding: "12px 24px", background: "#1a3a1a", color: "#4CAF50", fontFamily: "'Bebas Neue'", fontSize: 18, borderRadius: 8, border: "1px solid #2a4a2a", cursor: "pointer" }}>VIEW SQUADS</button>
                        <button onClick={runSeasonSim} style={{ padding: "12px 24px", background: "linear-gradient(90deg,#FFD700,#FFA500)", color: "#000", fontFamily: "'Bebas Neue'", fontSize: 18, borderRadius: 8, border: "none", cursor: "pointer" }}>SIMULATE SEASON 🏏</button>
                      </div>
                    </div>
                  : <div>
                      <div style={{ fontSize: 40, marginBottom: 8 }}>⏳</div>
                      <div style={{ color: "#444", fontSize: 16 }}>Next player loading...</div>
                    </div>
                }
              </div>
            )}
          </div>

          {/* RIGHT — Log / Chat / Squads tabs */}
          <div style={{ borderLeft: "1px solid #1a1a2e", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {/* Tabs */}
            <div style={{ display: "flex", borderBottom: "1px solid #1a1a2e", flexShrink: 0 }}>
              {[["log", "📋 Log"], ["chat", "💬 Chat"], ["squads", "👥 Squads"], ["queue", "📋 Queue"]].map(([tab, label]) => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  style={{ flex: 1, padding: "10px 4px", background: activeTab === tab ? "#1a1a2e" : "transparent", color: activeTab === tab ? "#FFD700" : "#444", border: "none", cursor: "pointer", fontSize: 11, fontFamily: "'Rajdhani'", borderBottom: activeTab === tab ? "2px solid #FFD700" : "2px solid transparent" }}>
                  {label}
                </button>
              ))}
            </div>

            {/* Log */}
            {activeTab === "log" && (
              <div style={{ flex: 1, overflowY: "auto", padding: 10 }}>
                {log.map((entry, i) => (
                  <div key={i} style={{ fontSize: 12, color: i === 0 ? "#ccc" : "#444", padding: "3px 0", borderBottom: "1px solid #0a0a14", lineHeight: 1.5 }}>{entry}</div>
                ))}
              </div>
            )}

            {/* Chat */}
            {activeTab === "chat" && (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <div style={{ flex: 1, overflowY: "auto", padding: 10 }}>
                  {chatMessages.map((msg, i) => {
                    const t = teams.find(x => x.id === msg.teamId);
                    return (
                      <div key={i} style={{ marginBottom: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
                          {t && <JerseyIcon team={t} size={14} />}
                          <span style={{ fontSize: 11, color: t?.color || "#666", fontWeight: 600 }}>{msg.userName}</span>
                          <span style={{ fontSize: 10, color: "#333" }}>{msg.time}</span>
                        </div>
                        <div style={{ fontSize: 13, color: "#aaa", paddingLeft: 19, lineHeight: 1.4 }}>{msg.message}</div>
                      </div>
                    );
                  })}
                  <div ref={chatEndRef} />
                </div>
                <div style={{ padding: 8, borderTop: "1px solid #1a1a2e", display: "flex", gap: 6 }}>
                  <input value={chatInput} onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && sendChat()}
                    placeholder="Type message..." maxLength={200}
                    style={{ flex: 1, padding: "8px 10px", background: "#0a0a18", border: "1px solid #1e1e3a", borderRadius: 6, color: "#fff", fontSize: 13, fontFamily: "'Rajdhani'" }} />
                  <button onClick={sendChat} style={{ padding: "8px 12px", background: "#FFD700", color: "#000", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>→</button>
                </div>
              </div>
            )}

            {/* Squads */}
            {activeTab === "squads" && (
              <div style={{ flex: 1, overflowY: "auto", padding: 10 }}>
                {teams.map(t => (
                  <div key={t.id} style={{ marginBottom: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, background: `${t.color}18`, borderRadius: 6, padding: "5px 8px" }}>
                      <JerseyIcon team={t} size={20} />
                      <span style={{ fontFamily: "'Bebas Neue'", fontSize: 16, color: t.color }}>{t.shortName}</span>
                      <span style={{ fontSize: 11, color: "#555", marginLeft: "auto" }}>{t.players?.length || 0}/20</span>
                      <span style={{ fontSize: 11, color: "#FFD700" }}>{formatAmount(t.purseRemaining)}</span>
                    </div>
                    {(t.players || []).map(p => (
                      <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#555", padding: "2px 8px", borderBottom: "1px solid #0a0a14" }}>
                        <span style={{ color: p.country === "India" ? "#888" : "#6a8" }}>{roleIcon(p.role)} {p.name}</span>
                        <span style={{ color: "#FFD700" }}>{formatAmount(p.soldPrice || p.basePrice)}</span>
                      </div>
                    ))}
                    {(!t.players || t.players.length === 0) && <div style={{ fontSize: 11, color: "#2a2a3a", padding: "4px 8px" }}>No players yet</div>}
                  </div>
                ))}
              </div>
            )}

            {/* Queue */}
            {activeTab === "queue" && (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <div style={{ padding: "8px 10px", borderBottom: "1px solid #1a1a2e", flexShrink: 0 }}>
                  <input value={playerFilter} onChange={e => setPlayerFilter(e.target.value)}
                    placeholder="Search player..." style={{ width: "100%", padding: "6px 10px", background: "#0a0a18", border: "1px solid #1e1e3a", borderRadius: 6, color: "#fff", fontSize: 12, fontFamily: "'Rajdhani'", boxSizing: "border-box" }} />
                  <div style={{ display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
                    {["All", "Bat", "Bowl", "AR", "WK"].map((f, i) => {
                      const full = ["All", "Batsman", "Bowler", "All-Rounder", "Wicket Keeper"][i];
                      return <button key={f} onClick={() => setActiveFilter(full)} style={{ padding: "3px 8px", background: activeFilter === full ? "#FFD700" : "#111", color: activeFilter === full ? "#000" : "#555", fontSize: 10, borderRadius: 10, border: "1px solid #1e1e2e", cursor: "pointer" }}>{f}</button>;
                    })}
                  </div>
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: "6px 10px" }}>
                  <div style={{ fontSize: 10, color: "#333", marginBottom: 6 }}>{pQueue.length} players remaining</div>
                  {pQueue.slice(0, 50).map((p, i) => (
                    <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 0", borderBottom: "1px solid #0a0a14" }}>
                      <span style={{ color: "#333", fontSize: 10, minWidth: 16 }}>{i + 1}</span>
                      <span style={{ fontSize: 13 }}>{flagEmoji(p.country)}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, color: "#aaa" }}>{p.name}</div>
                        <div style={{ fontSize: 10, color: "#444" }}>{p.role} · {formatAmount(p.basePrice)}</div>
                      </div>
                      <div style={{ fontFamily: "'Bebas Neue'", fontSize: 14, color: p.rating >= 88 ? "#FFD700" : "#555" }}>{p.rating}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ─── POST AUCTION / SQUADS ───────────────────────────────────────────────
  if (screen === "done") return (
    <div style={{ minHeight: "100vh", background: "#0a0a1a", fontFamily: "'Rajdhani',sans-serif", color: "#fff", padding: 20 }}>
      <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Bebas+Neue&display=swap" rel="stylesheet" />
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <h1 style={{ fontFamily: "'Bebas Neue'", fontSize: 36, color: "#FFD700", margin: 0, letterSpacing: 2 }}>FINAL SQUADS</h1>
          <button onClick={runSeasonSim} style={{ padding: "12px 28px", background: "linear-gradient(90deg,#FFD700,#FFA500)", color: "#000", fontFamily: "'Bebas Neue'", fontSize: 18, borderRadius: 8, border: "none", cursor: "pointer" }}>SIMULATE SEASON 🏏</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 16 }}>
          {teams.map(team => {
            const indian = team.players?.filter(p => p.country === "India").length || 0;
            const overseas = team.players?.filter(p => p.country !== "India").length || 0;
            return (
              <div key={team.id} style={{ background: "#0d0d1f", border: `1px solid ${team.color}44`, borderRadius: 12, overflow: "hidden" }}>
                <div style={{ background: team.color, padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <JerseyIcon team={team} size={32} />
                    <div>
                      <div style={{ fontFamily: "'Bebas Neue'", fontSize: 20, color: "#fff" }}>{team.shortName}</div>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }}>{team.name}</div>
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)" }}>PURSE LEFT</div>
                    <div style={{ fontFamily: "'Bebas Neue'", fontSize: 18, color: "#fff" }}>{formatAmount(team.purseRemaining)}</div>
                  </div>
                </div>
                <div style={{ padding: "10px 14px" }}>
                  <div style={{ display: "flex", gap: 12, fontSize: 11, color: "#555", marginBottom: 8 }}>
                    <span>🇮🇳 {indian} Indian</span>
                    <span>🌍 {overseas} Overseas</span>
                    <span>Total: {team.players?.length || 0}</span>
                  </div>
                  <div style={{ maxHeight: 220, overflowY: "auto" }}>
                    {(team.players || []).map(p => (
                      <div key={p.id} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #111", fontSize: 12 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <span>{roleIcon(p.role)}</span>
                          <span style={{ color: p.country === "India" ? "#ccc" : "#8bc" }}>{p.name}</span>
                        </div>
                        <span style={{ color: "#FFD700" }}>{formatAmount(p.soldPrice || p.basePrice)}</span>
                      </div>
                    ))}
                    {!team.players?.length && <div style={{ color: "#333", fontSize: 12, textAlign: "center", padding: 10 }}>No players bought</div>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 24 }}>
          <h2 style={{ fontFamily: "'Bebas Neue'", fontSize: 24, color: "#555", marginBottom: 12 }}>UNSOLD PLAYERS ({room?.unsoldPlayers?.length || 0})</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {(room?.unsoldPlayers || []).map(p => (
              <div key={p.id} style={{ background: "#0d0d1f", border: "1px solid #1a1a2e", borderRadius: 6, padding: "4px 12px", fontSize: 12, color: "#555" }}>
                {flagEmoji(p.country)} {p.name} · {formatAmount(p.basePrice)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  // ─── SEASON ──────────────────────────────────────────────────────────────
  if (screen === "season" && seasonData) {
    const { table, matches, champion } = seasonData;
    return (
      <div style={{ minHeight: "100vh", background: "#0a0a1a", fontFamily: "'Rajdhani',sans-serif", color: "#fff", padding: 20 }}>
        <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Bebas+Neue&display=swap" rel="stylesheet" />
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          {champion && (
            <div style={{ textAlign: "center", background: `${champion.color}18`, border: `2px solid ${champion.color}66`, borderRadius: 16, padding: "24px 16px", marginBottom: 24 }}>
              <div style={{ fontSize: 56, marginBottom: 8 }}>🏆</div>
              <div style={{ fontFamily: "'Bebas Neue'", fontSize: 14, color: "#555", letterSpacing: 3 }}>IPL CHAMPIONS</div>
              <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 12, marginTop: 4 }}>
                <JerseyIcon team={champion} size={48} />
                <div style={{ fontFamily: "'Bebas Neue'", fontSize: 44, color: champion.color, letterSpacing: 2 }}>{champion.name}</div>
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
            {[["table","Points Table"],["fixtures","Fixtures"],["stats","Stats"]].map(([v, l]) => (
              <button key={v} onClick={() => setSeasonView(v)}
                style={{ padding: "10px 20px", background: seasonView === v ? "#FFD700" : "#0d0d1f", color: seasonView === v ? "#000" : "#555", fontFamily: "'Bebas Neue'", fontSize: 16, letterSpacing: 1, borderRadius: 8, border: "1px solid #1e1e3a", cursor: "pointer" }}>
                {l}
              </button>
            ))}
            <button onClick={() => setScreen("done")} style={{ marginLeft: "auto", padding: "10px 18px", background: "#0d0d1f", color: "#555", fontFamily: "'Bebas Neue'", fontSize: 14, borderRadius: 8, border: "1px solid #1e1e3a", cursor: "pointer" }}>← Squads</button>
          </div>
          {seasonView === "table" && (
            <div style={{ background: "#0d0d1f", border: "1px solid #1e1e3a", borderRadius: 12, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "28px 1fr 50px 50px 50px 60px 70px", padding: "10px 16px", background: "#08080f", fontSize: 11, color: "#333", letterSpacing: 1 }}>
                <span>#</span><span>TEAM</span><span style={{ textAlign: "center" }}>P</span><span style={{ textAlign: "center" }}>W</span><span style={{ textAlign: "center" }}>L</span><span style={{ textAlign: "center" }}>PTS</span><span style={{ textAlign: "center" }}>NRR</span>
              </div>
              {table.map((row, i) => {
                const t = teams.find(x => x.id === row.id);
                return (
                  <div key={row.id} style={{ display: "grid", gridTemplateColumns: "28px 1fr 50px 50px 50px 60px 70px", padding: "12px 16px", borderTop: "1px solid #0d0d18", background: i < 4 ? "#0d1a0d" : "transparent" }}>
                    <span style={{ color: "#333", fontSize: 13 }}>{i + 1}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {t && <JerseyIcon team={t} size={20} />}
                      <span style={{ fontSize: 14, color: i < 4 ? "#fff" : "#666" }}>{row.shortName}</span>
                      {i < 4 && <span style={{ fontSize: 10, color: "#4CAF50" }}>Q</span>}
                    </div>
                    {[row.played, row.won, row.lost].map((v, j) => <span key={j} style={{ textAlign: "center", fontSize: 14, color: "#666" }}>{v}</span>)}
                    <span style={{ textAlign: "center", fontFamily: "'Bebas Neue'", fontSize: 18, color: "#FFD700" }}>{row.pts}</span>
                    <span style={{ textAlign: "center", fontSize: 13, color: row.nrr >= 0 ? "#4CAF50" : "#FF6666" }}>{row.nrr >= 0 ? "+" : ""}{row.nrr}</span>
                  </div>
                );
              })}
            </div>
          )}
          {seasonView === "fixtures" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 10 }}>
              {matches.map((m, i) => {
                const t1 = teams.find(t => t.id === m.team1Id), t2 = teams.find(t => t.id === m.team2Id);
                if (!t1 || !t2) return null;
                return (
                  <div key={i} style={{ background: "#0d0d1f", border: "1px solid #1a1a2e", borderRadius: 10, padding: "12px 14px" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <div style={{ textAlign: "center" }}>
                        <JerseyIcon team={t1} size={28} />
                        <div style={{ fontFamily: "'Bebas Neue'", fontSize: 22, color: m.winnerId === t1.id ? "#FFD700" : "#555" }}>{m.score1}</div>
                      </div>
                      <div style={{ color: "#2a2a3a", fontSize: 11 }}>VS</div>
                      <div style={{ textAlign: "center" }}>
                        <JerseyIcon team={t2} size={28} />
                        <div style={{ fontFamily: "'Bebas Neue'", fontSize: 22, color: m.winnerId === t2.id ? "#FFD700" : "#555" }}>{m.score2}</div>
                      </div>
                    </div>
                    <div style={{ textAlign: "center", fontSize: 11, color: "#4CAF50", marginTop: 4 }}>
                      {teams.find(t => t.id === m.winnerId)?.shortName} won by {m.margin} runs
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {seasonView === "stats" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {[["🧡 ORANGE CAP", "#FF6B35", "batting", "runs"], ["💜 PURPLE CAP", "#9B59B6", "bowling", "wkts"]].map(([title, color, stat, unit]) => (
                <div key={title} style={{ background: "#0d0d1f", border: `1px solid ${color}44`, borderRadius: 12, padding: 16 }}>
                  <div style={{ fontFamily: "'Bebas Neue'", fontSize: 18, color, letterSpacing: 1, marginBottom: 10 }}>{title}</div>
                  {teams.map(t => {
                    const top = [...(t.players || [])].sort((a, b) => b[stat] - a[stat])[0];
                    if (!top) return null;
                    const val = stat === "batting" ? Math.floor(top[stat] * 5.4 + Math.random() * 80) : Math.floor(top[stat] * 0.28 + Math.random() * 6);
                    return (
                      <div key={t.id} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid #111", fontSize: 12 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <JerseyIcon team={t} size={16} />
                          <span style={{ color: "#aaa" }}>{top.name}</span>
                        </div>
                        <span style={{ color, fontWeight: 600 }}>{val} {unit}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
              <div style={{ gridColumn: "1/-1", background: "#0d0d1f", border: "1px solid #FFD70044", borderRadius: 12, padding: 16 }}>
                <div style={{ fontFamily: "'Bebas Neue'", fontSize: 18, color: "#FFD700", letterSpacing: 1, marginBottom: 10 }}>⭐ MOST EXPENSIVE BUYS</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 8 }}>
                  {(room?.soldPlayers || []).sort((a, b) => b.price - a.price).slice(0, 10).map(s => {
                    const t = teams.find(x => x.id === s.teamId);
                    return (
                      <div key={s.player.id} style={{ background: "#08080f", borderRadius: 8, padding: "10px 12px" }}>
                        <div style={{ fontSize: 12, color: "#fff" }}>{s.player.name}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
                          {t && <JerseyIcon team={t} size={14} />}
                          <span style={{ fontSize: 11, color: "#555" }}>{t?.shortName}</span>
                        </div>
                        <div style={{ fontFamily: "'Bebas Neue'", fontSize: 18, color: "#FFD700", marginTop: 2 }}>{formatAmount(s.price)}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}

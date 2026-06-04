const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getNextBid(current) {
  if (current < 25) return current + 5;
  if (current < 50) return current + 5;
  if (current < 75) return current + 25;
  if (current < 100) return current + 25;
  if (current < 200) return current + 10;
  if (current < 500) return current + 20;
  if (current < 1000) return current + 50;
  return current + 100;
}

function formatAmount(lakhs) {
  if (lakhs >= 100) {
    const cr = lakhs / 100;
    return `₹${cr % 1 === 0 ? cr : cr.toFixed(2)} Cr`;
  }
  return `₹${lakhs}L`;
}

function broadcastRoom(room) {
  io.to(room.code).emit('room_state', sanitizeRoom(room));
}

function sanitizeRoom(room) {
  return {
    code: room.code,
    teams: room.teams,
    users: room.users,
    settings: room.settings,
    auctionStarted: room.auctionStarted,
    auctionPaused: room.auctionPaused,
    currentPlayer: room.currentPlayer,
    currentBid: room.currentBid,
    highestBidder: room.highestBidder,
    highestBidderName: room.highestBidderName,
    bidHistory: (room.bidHistory || []).slice(0, 20),
    log: (room.log || []).slice(0, 80),
    soldPlayers: room.soldPlayers,
    unsoldPlayers: room.unsoldPlayers,
    playerQueue: room.playerQueue,
    auctionActive: room.auctionActive,
    timeLeft: room.timeLeft,
    auctionComplete: room.auctionComplete,
    rtmActive: room.rtmActive,
    rtmPlayer: room.rtmPlayer,
    rtmOriginalTeam: room.rtmOriginalTeam,
    rtmWinningTeam: room.rtmWinningTeam,
    rtmWinningBid: room.rtmWinningBid,
  };
}

function getTeamInfo(id) {
  const teams = {
    MI: { name: 'Mumbai Indians', shortName: 'MI', color: '#004BA0', accent: '#D4AF37' },
    CSK: { name: 'Chennai Super Kings', shortName: 'CSK', color: '#FDB913', accent: '#0081C9' },
    RCB: { name: 'Royal Challengers Bengaluru', shortName: 'RCB', color: '#EC1C24', accent: '#FFD700' },
    KKR: { name: 'Kolkata Knight Riders', shortName: 'KKR', color: '#3A225D', accent: '#F5A623' },
    SRH: { name: 'Sunrisers Hyderabad', shortName: 'SRH', color: '#F7A721', accent: '#E8461E' },
    RR: { name: 'Rajasthan Royals', shortName: 'RR', color: '#EA1A85', accent: '#254AA5' },
    DC: { name: 'Delhi Capitals', shortName: 'DC', color: '#0078BC', accent: '#EF1C25' },
    PBKS: { name: 'Punjab Kings', shortName: 'PBKS', color: '#C8102E', accent: '#AAAAAA' },
    LSG: { name: 'Lucknow Super Giants', shortName: 'LSG', color: '#A4C639', accent: '#004B8D' },
    GT: { name: 'Gujarat Titans', shortName: 'GT', color: '#1D2951', accent: '#C8A84B' },
  };
  return teams[id] || { name: id, shortName: id, color: '#333', accent: '#FFD700' };
}

function startTimer(room) {
  if (room.timerInterval) clearInterval(room.timerInterval);
  room.timeLeft = 10;
  room.timerInterval = setInterval(() => {
    if (room.auctionPaused) return;
    room.timeLeft--;
    io.to(room.code).emit('timer_tick', { timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) {
      clearInterval(room.timerInterval);
      room.timerInterval = null;
      soldPlayer(room);
    }
  }, 1000);
}

function resetTimer(room) {
  room.timeLeft = 10;
  if (room.timerInterval) clearInterval(room.timerInterval);
  startTimer(room);
}

function soldPlayer(room) {
  if (!room.currentPlayer || room.rtmActive) return;
  const player = room.currentPlayer;
  const winnerId = room.highestBidder;
  const winnerTeam = room.teams.find(t => t.id === winnerId);

  // Check if this player had a previous team → trigger RTM window
  const prevTeamId = player.previousTeam;
  const prevTeam = prevTeamId ? room.teams.find(t => t.id === prevTeamId) : null;

  if (prevTeam && winnerId && winnerId !== prevTeamId && prevTeam.rtmRemaining > 0) {
    // RTM window: pause and ask prev team
    room.rtmActive = true;
    room.rtmPlayer = player;
    room.rtmOriginalTeam = prevTeamId;
    room.rtmWinningTeam = winnerId;
    room.rtmWinningBid = room.currentBid;
    if (room.timerInterval) clearInterval(room.timerInterval);
    room.log.unshift(`🔄 RTM available! ${prevTeam.name} can match ₹${formatAmount(room.currentBid)} for ${player.name}`);
    broadcastRoom(room);
    return;
  }

  completeSale(room, player, winnerId, room.currentBid);
}

function completeSale(room, player, winnerId, price) {
  const winnerTeam = room.teams.find(t => t.id === winnerId);
  if (winnerTeam && winnerId) {
    winnerTeam.purseRemaining -= price;
    winnerTeam.players.push({ ...player, soldPrice: price });
    room.log.unshift(`🏏 ${player.name} SOLD to ${winnerTeam.name} for ${formatAmount(price)}!`);
    room.soldPlayers.push({ player, team: winnerTeam.name, teamId: winnerId, price });
  } else {
    room.log.unshift(`❌ ${player.name} went UNSOLD`);
    room.unsoldPlayers.push(player);
  }

  room.currentPlayer = null;
  room.currentBid = 0;
  room.highestBidder = null;
  room.highestBidderName = null;
  room.bidHistory = [];
  room.auctionActive = false;
  room.rtmActive = false;
  room.rtmPlayer = null;
  room.rtmOriginalTeam = null;
  room.rtmWinningTeam = null;
  room.rtmWinningBid = null;
  room.playerQueue.shift();

  broadcastRoom(room);

  if (room.playerQueue.length === 0) {
    room.auctionComplete = true;
    room.log.unshift('🏆 AUCTION COMPLETE! All players sold.');
    broadcastRoom(room);
    return;
  }

  // Auto-nominate next player after 3s
  setTimeout(() => {
    if (!room.auctionPaused) nominateNext(room);
  }, 3000);
}

function nominateNext(room) {
  if (!room.playerQueue.length || room.auctionComplete) return;
  const player = room.playerQueue[0];
  room.currentPlayer = player;
  room.currentBid = player.basePrice;
  room.highestBidder = null;
  room.highestBidderName = null;
  room.bidHistory = [];
  room.auctionActive = true;
  room.log.unshift(`📢 ${player.name} up for auction — Base: ${formatAmount(player.basePrice)}`);
  broadcastRoom(room);
  startTimer(room);
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('create_room', ({ adminName, purse }) => {
    const code = generateRoomCode();
    const room = {
      code, adminId: socket.id,
      settings: { purse: purse || 12000 },
      teams: [], users: [],
      currentPlayer: null, currentBid: 0,
      highestBidder: null, highestBidderName: null,
      bidHistory: [], log: [], soldPlayers: [], unsoldPlayers: [],
      playerQueue: [], auctionActive: false, auctionStarted: false,
      auctionPaused: false, auctionComplete: false,
      timeLeft: 10, timerInterval: null,
      rtmActive: false, rtmPlayer: null,
      rtmOriginalTeam: null, rtmWinningTeam: null, rtmWinningBid: null,
      chatMessages: [],
    };
    rooms[code] = room;
    socket.join(code);
    socket.roomCode = code;
    socket.userName = adminName;
    room.users.push({ id: socket.id, name: adminName, teamId: null, isAdmin: true });
    socket.emit('room_created', { code, userId: socket.id });
  });

  socket.on('join_room', ({ code, userName }) => {
    const room = rooms[code];
    if (!room) return socket.emit('join_error', { message: 'Room not found! Check the code.' });
    socket.join(code);
    socket.roomCode = code;
    socket.userName = userName;
    const existing = room.users.find(u => u.id === socket.id);
    if (!existing) room.users.push({ id: socket.id, name: userName, teamId: null, isAdmin: false });
    room.log.unshift(`👋 ${userName} joined the room`);
    socket.emit('joined_room', { userId: socket.id });
    broadcastRoom(room);
  });

  socket.on('select_team', ({ teamId }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;
    const alreadyTaken = room.teams.find(t => t.id === teamId && t.ownerId !== socket.id);
    if (alreadyTaken) return socket.emit('join_error', { message: 'Team already taken!' });
    // Remove previous selection
    room.teams = room.teams.filter(t => t.ownerId !== socket.id);
    const teamInfo = getTeamInfo(teamId);
    room.teams.push({ ...teamInfo, id: teamId, ownerId: socket.id, isAI: false, purseRemaining: room.settings.purse, players: [], rtmRemaining: 2 });
    const user = room.users.find(u => u.id === socket.id);
    if (user) user.teamId = teamId;
    room.log.unshift(`${teamInfo.name} selected by ${user?.name}`);
    broadcastRoom(room);
  });

  socket.on('start_auction', ({ playerQueue }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.adminId !== socket.id) return;
    room.playerQueue = playerQueue;
    room.auctionStarted = true;
    room.log.unshift('🎯 Auction started! First player coming up...');
    broadcastRoom(room);
    setTimeout(() => nominateNext(room), 2000);
  });

  socket.on('place_bid', ({ teamId, amount }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || !room.auctionActive || room.auctionPaused || room.rtmActive) return;
    const team = room.teams.find(t => t.id === teamId);
    if (!team) return socket.emit('join_error', { message: 'Team not found' });
    if (amount <= room.currentBid) return socket.emit('join_error', { message: 'Bid too low!' });
    
    // Squad limit checks
    const isOverseas = room.currentPlayer?.country !== 'India';
    const overseasCount = team.players.filter(p => p.country !== 'India').length;
    const totalCount = team.players.length;
    if (totalCount >= 20) return socket.emit('join_error', { message: 'Squad full! (Max 20)' });
    if (isOverseas && overseasCount >= 8) return socket.emit('join_error', { message: 'Overseas limit reached! (Max 8)' });
    if (amount > team.purseRemaining) return socket.emit('join_error', { message: 'Not enough purse!' });

    room.currentBid = amount;
    room.highestBidder = teamId;
    room.highestBidderName = team.name;
    room.bidHistory.unshift({ team: team.name, teamId, amount, time: Date.now() });
    room.log.unshift(`💰 ${team.name} bid ${formatAmount(amount)} for ${room.currentPlayer?.name}`);
    resetTimer(room);
    broadcastRoom(room);
  });

  socket.on('mark_unsold', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.adminId !== socket.id || !room.auctionActive) return;
    if (room.timerInterval) clearInterval(room.timerInterval);
    const player = room.currentPlayer;
    room.log.unshift(`❌ ${player?.name} marked UNSOLD by host`);
    room.unsoldPlayers.push(player);
    room.currentPlayer = null;
    room.currentBid = 0;
    room.highestBidder = null;
    room.highestBidderName = null;
    room.bidHistory = [];
    room.auctionActive = false;
    room.playerQueue.shift();
    broadcastRoom(room);
    if (room.playerQueue.length === 0) {
      room.auctionComplete = true;
      room.log.unshift('🏆 AUCTION COMPLETE!');
      broadcastRoom(room);
      return;
    }
    setTimeout(() => { if (!room.auctionPaused) nominateNext(room); }, 3000);
  });

  socket.on('pause_auction', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.adminId !== socket.id) return;
    room.auctionPaused = true;
    room.log.unshift('⏸️ Auction PAUSED by host');
    broadcastRoom(room);
  });

  socket.on('resume_auction', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.adminId !== socket.id) return;
    room.auctionPaused = false;
    room.log.unshift('▶️ Auction RESUMED by host');
    broadcastRoom(room);
    if (room.auctionActive && room.currentPlayer) startTimer(room);
    else if (!room.currentPlayer && room.playerQueue.length) nominateNext(room);
  });

  socket.on('use_rtm', ({ teamId, accept }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || !room.rtmActive) return;
    if (accept) {
      const team = room.teams.find(t => t.id === teamId);
      if (team && team.rtmRemaining > 0 && team.purseRemaining >= room.rtmWinningBid) {
        team.rtmRemaining--;
        room.log.unshift(`🔄 RTM used! ${team.name} matches ${formatAmount(room.rtmWinningBid)} and retains ${room.rtmPlayer?.name}`);
        completeSale(room, room.rtmPlayer, teamId, room.rtmWinningBid);
      } else {
        socket.emit('join_error', { message: 'Cannot use RTM — insufficient purse or no RTMs left' });
      }
    } else {
      room.log.unshift(`❌ ${room.teams.find(t=>t.id===room.rtmOriginalTeam)?.name} declined RTM`);
      completeSale(room, room.rtmPlayer, room.rtmWinningTeam, room.rtmWinningBid);
    }
  });

  socket.on('chat_message', ({ message }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;
    const user = room.users.find(u => u.id === socket.id);
    const team = room.teams.find(t => t.ownerId === socket.id);
    const msg = {
      id: Date.now(),
      userName: user?.name || 'Unknown',
      teamId: team?.id,
      teamName: team?.name,
      teamColor: team?.color,
      message: message.slice(0, 200),
      time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    };
    room.chatMessages.push(msg);
    if (room.chatMessages.length > 100) room.chatMessages.shift();
    io.to(code).emit('chat_message', msg);
  });

  socket.on('get_room_state', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (room) {
      socket.emit('room_state', sanitizeRoom(room));
      // Also send chat history
      socket.emit('chat_history', room.chatMessages || []);
    }
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const user = room.users.find(u => u.id === socket.id);
    if (user) room.log.unshift(`👋 ${user.name} disconnected`);
    room.users = room.users.filter(u => u.id !== socket.id);
    broadcastRoom(room);
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', rooms: Object.keys(rooms).length }));
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`IPL Auction Server on port ${PORT}`));

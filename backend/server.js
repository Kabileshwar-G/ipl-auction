const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getNextBid(current) {
  const cr = 100; // 1 Cr = 100 lakhs
  const c = current;
  if (c < 25) return c + 5;
  if (c < 50) return c + 5;
  if (c < 75) return c + 25;
  if (c < cr) return c + 25;
  if (c < 2 * cr) return c + 10;
  if (c < 5 * cr) return c + 20;
  if (c < 10 * cr) return c + 50;
  return c + 100;
}

function createAIBid(room) {
  if (!room.currentPlayer || !room.auctionActive) return;
  const aiTeams = room.teams.filter(t => t.isAI && t.purseRemaining > room.currentBid * 1.1);
  if (aiTeams.length === 0) return;
  const bidder = room.highestBidder;
  const eligible = aiTeams.filter(t => t.id !== bidder);
  if (eligible.length === 0) return;
  const chance = Math.random();
  if (chance < 0.45) return;
  const team = eligible[Math.floor(Math.random() * eligible.length)];
  const nextBid = getNextBid(room.currentBid);
  if (nextBid > team.purseRemaining) return;
  room.currentBid = nextBid;
  room.highestBidder = team.id;
  room.bidHistory.unshift({ team: team.name, amount: nextBid, time: Date.now() });
  room.log.unshift(`${team.name} bid ₹${formatAmount(nextBid)}`);
  resetTimer(room);
  io.to(room.code).emit('bid_update', {
    currentBid: room.currentBid,
    highestBidder: room.highestBidder,
    highestBidderName: team.name,
    bidHistory: room.bidHistory.slice(0, 20),
    log: room.log.slice(0, 50),
    timeLeft: room.timeLeft
  });
}

function formatAmount(lakhs) {
  if (lakhs >= 100) return `${(lakhs / 100).toFixed(lakhs % 100 === 0 ? 0 : 2)} Cr`;
  return `${lakhs}L`;
}

function resetTimer(room) {
  room.timeLeft = 15;
  if (room.timerInterval) clearInterval(room.timerInterval);
  room.timerInterval = setInterval(() => {
    room.timeLeft--;
    io.to(room.code).emit('timer_tick', { timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) {
      clearInterval(room.timerInterval);
      soldPlayer(room);
    } else if (room.timeLeft === 8 || room.timeLeft === 5) {
      setTimeout(() => createAIBid(room), 1200 + Math.random() * 1500);
    }
  }, 1000);
}

function soldPlayer(room) {
  if (!room.currentPlayer) return;
  const player = room.currentPlayer;
  const winnerId = room.highestBidder;
  const winnerTeam = room.teams.find(t => t.id === winnerId);
  if (winnerTeam) {
    winnerTeam.purseRemaining -= room.currentBid;
    winnerTeam.players.push({ ...player, soldPrice: room.currentBid });
    room.log.unshift(`🏏 ${player.name} SOLD to ${winnerTeam.name} for ₹${formatAmount(room.currentBid)}!`);
    room.soldPlayers.push({ player, team: winnerTeam.name, teamId: winnerId, price: room.currentBid });
  } else {
    room.log.unshift(`${player.name} went UNSOLD`);
    room.unsoldPlayers.push(player);
  }
  room.currentPlayer = null;
  room.currentBid = 0;
  room.highestBidder = null;
  room.auctionActive = false;
  room.playerQueue.shift();
  io.to(room.code).emit('player_sold', {
    player, winnerTeam: winnerTeam ? winnerTeam.name : null,
    winnerId, price: room.currentBid,
    teams: room.teams, log: room.log.slice(0, 50),
    soldPlayers: room.soldPlayers
  });
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ adminName, purse, settings }) => {
    const code = generateRoomCode();
    const room = {
      code, adminId: socket.id,
      settings: { purse: purse || 12000, maxPlayers: 25, minPlayers: 18, overseasLimit: 8 },
      teams: [], users: [],
      currentPlayer: null, currentBid: 0,
      highestBidder: null, highestBidderName: null,
      bidHistory: [], log: [], soldPlayers: [], unsoldPlayers: [],
      playerQueue: [], auctionActive: false, auctionStarted: false,
      timeLeft: 15, timerInterval: null
    };
    rooms[code] = room;
    socket.join(code);
    socket.roomCode = code;
    socket.emit('room_created', { code, settings: room.settings });
    console.log(`Room created: ${code} by ${adminName}`);
  });

  socket.on('join_room', ({ code, userName }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', { message: 'Room not found!' });
    if (room.auctionStarted) return socket.emit('error', { message: 'Auction already started!' });
    socket.join(code);
    socket.roomCode = code;
    const user = { id: socket.id, name: userName, teamId: null };
    room.users.push(user);
    socket.emit('joined_room', { room: sanitizeRoom(room), userId: socket.id });
    io.to(code).emit('user_joined', { users: room.users, teams: room.teams, log: [`${userName} joined the room`] });
  });

  socket.on('select_team', ({ code, teamId, teamData }) => {
    const room = rooms[code];
    if (!room) return;
    const alreadyTaken = room.teams.find(t => t.id === teamId && t.ownerId !== socket.id);
    if (alreadyTaken) return socket.emit('error', { message: 'Team already taken!' });
    const existing = room.teams.find(t => t.ownerId === socket.id);
    if (existing) { existing.id = teamId; Object.assign(existing, teamData); }
    else room.teams.push({ ...teamData, id: teamId, ownerId: socket.id, isAI: false, purseRemaining: room.settings.purse, players: [] });
    const user = room.users.find(u => u.id === socket.id);
    if (user) user.teamId = teamId;
    room.log.unshift(`${teamData.name} selected by ${user?.name || 'Player'}`);
    io.to(code).emit('teams_updated', { teams: room.teams, users: room.users, log: room.log.slice(0, 50) });
  });

  socket.on('start_auction', ({ code, playerQueue }) => {
    const room = rooms[code];
    if (!room || room.adminId !== socket.id) return;
    const IPL_TEAMS = ['MI','CSK','RCB','KKR','SRH','RR','DC','PBKS','LSG','GT'];
    IPL_TEAMS.forEach(tid => {
      if (!room.teams.find(t => t.id === tid)) {
        const teamInfo = getTeamInfo(tid);
        room.teams.push({ ...teamInfo, id: tid, ownerId: null, isAI: true, purseRemaining: room.settings.purse, players: [] });
      }
    });
    room.playerQueue = [...playerQueue];
    room.auctionStarted = true;
    room.log.unshift('🎯 Auction has started!');
    io.to(code).emit('auction_started', { teams: room.teams, playerQueue: room.playerQueue, log: room.log.slice(0, 50) });
    setTimeout(() => nominateNextPlayer(room), 2000);
  });

  socket.on('place_bid', ({ code, teamId, amount }) => {
    const room = rooms[code];
    if (!room || !room.auctionActive || !room.currentPlayer) return;
    const team = room.teams.find(t => t.id === teamId);
    if (!team || team.purseRemaining < amount) return socket.emit('error', { message: 'Insufficient purse!' });
    if (amount <= room.currentBid) return socket.emit('error', { message: 'Bid must be higher!' });
    room.currentBid = amount;
    room.highestBidder = teamId;
    room.bidHistory.unshift({ team: team.name, amount, time: Date.now() });
    room.log.unshift(`${team.name} bid ₹${formatAmount(amount)} for ${room.currentPlayer.name}`);
    resetTimer(room);
    io.to(code).emit('bid_update', {
      currentBid: room.currentBid, highestBidder: teamId,
      highestBidderName: team.name, bidHistory: room.bidHistory.slice(0, 20),
      log: room.log.slice(0, 50), timeLeft: room.timeLeft
    });
  });

  socket.on('nominate_player', ({ code, player }) => {
    const room = rooms[code];
    if (!room || room.adminId !== socket.id) return;
    if (room.timerInterval) clearInterval(room.timerInterval);
    room.currentPlayer = player;
    room.currentBid = player.basePrice;
    room.highestBidder = null;
    room.bidHistory = [];
    room.auctionActive = true;
    room.log.unshift(`📢 ${player.name} up for auction — Base: ₹${formatAmount(player.basePrice)}`);
    io.to(code).emit('player_nominated', {
      player, currentBid: player.basePrice, log: room.log.slice(0, 50)
    });
    setTimeout(() => { resetTimer(room); createAIBid(room); }, 3000);
  });

  socket.on('get_room_state', ({ code }) => {
    const room = rooms[code];
    if (room) socket.emit('room_state', sanitizeRoom(room));
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    room.users = room.users.filter(u => u.id !== socket.id);
    io.to(code).emit('user_left', { users: room.users });
  });
});

function nominateNextPlayer(room) {
  if (!room.playerQueue.length) {
    room.log.unshift('🏆 Auction Complete!');
    io.to(room.code).emit('auction_complete', { teams: room.teams, soldPlayers: room.soldPlayers, log: room.log });
    return;
  }
  const player = room.playerQueue[0];
  if (room.adminId) {
    io.to(room.code).emit('suggest_nominate', { player });
  } else {
    io.to(room.code).emit('suggest_nominate', { player });
  }
}

function sanitizeRoom(room) {
  return {
    code: room.code, teams: room.teams, users: room.users,
    settings: room.settings, auctionStarted: room.auctionStarted,
    currentPlayer: room.currentPlayer, currentBid: room.currentBid,
    highestBidder: room.highestBidder, bidHistory: room.bidHistory.slice(0, 20),
    log: room.log.slice(0, 50), soldPlayers: room.soldPlayers,
    playerQueue: room.playerQueue, auctionActive: room.auctionActive,
    timeLeft: room.timeLeft
  };
}

function getTeamInfo(id) {
  const teams = {
    MI: { name: 'Mumbai Indians', shortName: 'MI', color: '#004BA0', accent: '#D4AF37' },
    CSK: { name: 'Chennai Super Kings', shortName: 'CSK', color: '#FDB913', accent: '#0081C9' },
    RCB: { name: 'Royal Challengers Bengaluru', shortName: 'RCB', color: '#EC1C24', accent: '#000000' },
    KKR: { name: 'Kolkata Knight Riders', shortName: 'KKR', color: '#3A225D', accent: '#F5A623' },
    SRH: { name: 'Sunrisers Hyderabad', shortName: 'SRH', color: '#F7A721', accent: '#E8461E' },
    RR: { name: 'Rajasthan Royals', shortName: 'RR', color: '#EA1A85', accent: '#254AA5' },
    DC: { name: 'Delhi Capitals', shortName: 'DC', color: '#0078BC', accent: '#EF1C25' },
    PBKS: { name: 'Punjab Kings', shortName: 'PBKS', color: '#AAAAAA', accent: '#ED1B24' },
    LSG: { name: 'Lucknow Super Giants', shortName: 'LSG', color: '#A4C639', accent: '#004B8D' },
    GT: { name: 'Gujarat Titans', shortName: 'GT', color: '#1D2951', accent: '#C8A84B' },
  };
  return teams[id] || { name: id, shortName: id, color: '#333', accent: '#gold' };
}

app.get('/health', (req, res) => res.json({ status: 'ok', rooms: Object.keys(rooms).length }));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`IPL Auction Server running on port ${PORT}`));

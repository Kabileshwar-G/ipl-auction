# 🏏 IPL Auction Simulator — Deploy Guide
## Friends play from anywhere via room code

---

## STEP 1 — Upload to GitHub (5 minutes)

1. Go to https://github.com and sign in (or create free account)
2. Click **New repository** → name it `ipl-auction` → **Create repository**
3. Download GitHub Desktop from https://desktop.github.com OR use the web uploader:
   - Drag the entire `ipl-auction` folder into the GitHub repo page
   - Commit message: "Initial commit" → Click **Commit changes**

---

## STEP 2 — Deploy Backend on Render.com (7 minutes)

The backend handles real-time Socket.io connections so all friends stay in sync.

1. Go to https://render.com → **Sign up free** (use GitHub login)
2. Click **New +** → **Web Service**
3. Connect your GitHub repo → select `ipl-auction`
4. Fill in these settings:
   - **Name**: `ipl-auction-backend`
   - **Root Directory**: `backend`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
5. Click **Create Web Service**
6. Wait ~3 minutes for deployment
7. **Copy your backend URL** — it looks like: `https://ipl-auction-backend.onrender.com`

---

## STEP 3 — Deploy Frontend on Netlify (5 minutes)

1. Go to https://netlify.com → **Sign up free**
2. Click **Add new site** → **Import an existing project** → Connect GitHub
3. Select your `ipl-auction` repo
4. Fill in:
   - **Base directory**: `frontend`
   - **Build command**: `npm run build`
   - **Publish directory**: `frontend/dist`
5. Click **Show advanced** → **New variable**:
   - Key: `VITE_BACKEND_URL`
   - Value: paste your Render URL from Step 2 (e.g. `https://ipl-auction-backend.onrender.com`)
6. Click **Deploy site**
7. Wait ~2 minutes → your site is live!
8. **Your URL** will look like: `https://ipl-auction-xyz.netlify.app`

---

## STEP 4 — Play with Friends!

### As the Admin (Room Creator):
1. Open your Netlify URL
2. Enter your name
3. Choose purse amount (₹100Cr / ₹120Cr / ₹150Cr)
4. Click **CREATE ROOM**
5. Share the 6-digit room code with friends (e.g. `AB12CD`)

### As a Friend:
1. Open the same Netlify URL
2. Enter your name
3. Type the room code → Click **JOIN**
4. Select an IPL team
5. Wait for admin to start

### During Auction:
- Admin sees "PUT UP FOR BID" button for each player
- Everyone can bid by clicking **BID ₹X.XX Cr**
- 15-second countdown after each bid
- AI bots fill any unchosen teams and bid automatically
- After all players are sold → click **SIMULATE SEASON**

---

## IMPORTANT NOTES

### Free tier limitations:
- Render free tier **spins down** after 15 minutes of inactivity
- First connection after inactivity takes ~30 seconds (normal!)
- For longer sessions, consider Render's $7/month starter plan

### Room code sharing:
- Share the 6-digit code via WhatsApp, Discord, etc.
- Up to 10 players per room
- AI bots auto-fill any unselected teams
- If someone disconnects, they can rejoin with the same code

### Local testing (before deploying):
```bash
# Terminal 1 — Backend
cd ipl-auction/backend
npm install
node server.js

# Terminal 2 — Frontend  
cd ipl-auction/frontend
npm install
npm run dev
# Open http://localhost:5173
```

---

## FOLDER STRUCTURE

```
ipl-auction/
├── backend/
│   ├── server.js          ← Socket.io server
│   ├── package.json
│   └── render.yaml        ← Render deploy config
└── frontend/
    ├── src/
    │   ├── App.jsx         ← Main app (all screens)
    │   ├── main.jsx
    │   ├── index.css
    │   └── data/
    │       └── players.js  ← 120+ real IPL players
    ├── index.html
    ├── package.json
    ├── vite.config.js
    └── netlify.toml        ← Netlify SPA routing
```

---

## FEATURES INCLUDED

✅ Real-time multiplayer via Socket.io room codes
✅ 10 IPL teams with authentic colors
✅ 120+ real players with ratings
✅ AI bots for empty team slots
✅ Live bidding with 15-second countdown
✅ Automatic bid increments (₹20L → ₹2Cr etc.)
✅ Purse tracking per team
✅ Auction log & bid history
✅ Player queue with role filters
✅ Complete squad builder
✅ Full IPL season simulation (45 league matches)
✅ Points table with NRR
✅ Orange Cap & Purple Cap stats
✅ Most expensive buys leaderboard
✅ Dark IPL theme with gold accents
✅ Mobile-responsive

---

Questions? The app runs entirely on free tiers — no credit card needed.

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
app.use(require('cors')());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ---------- Game State ----------
let currentRound = {
  id: 1,
  tickets: [],                // { ws, picks: [numbers], betAmount, ticketId }
  status: 'accepting',       // 'accepting' | 'drawing'
  drawnNumbers: [],
  timerStart: Date.now()
};

const ROUND_DURATION = 60_000;   // 60 seconds
const DRAW_DELAY = 5_000;        // 5 sec after stop accepting before result

// ---------- Pay Table ----------
const payouts = {
  2: 1, 3: 2, 4: 5, 5: 10, 6: 20,
  7: 50, 8: 100, 9: 500, 10: 1000
};

// ---------- Helper: Cryptographically secure drawing (20 unique numbers from 1-80) ----------
function drawNumbers() {
  const pool = Array.from({ length: 80 }, (_, i) => i + 1);
  const drawn = [];
  for (let i = 0; i < 20; i++) {
    const index = crypto.randomInt(0, pool.length);
    drawn.push(pool.splice(index, 1)[0]);
  }
  return drawn.sort((a,b)=>a-b);
}

// ---------- Game Loop ----------
function startRound() {
  currentRound = {
    id: currentRound.id + 1,
    tickets: [],
    status: 'accepting',
    drawnNumbers: [],
    timerStart: Date.now()
  };

  // Notify all clients: new round, countdown starts
  broadcast({ type: 'newRound', roundId: currentRound.id, timeLeft: ROUND_DURATION });

  // Stop accepting after ROUND_DURATION
  setTimeout(() => {
    currentRound.status = 'drawing';
    broadcast({ type: 'statusChange', status: 'drawing', message: 'No more bets. Drawing...' });

    // Wait a few seconds then draw
    setTimeout(() => {
      const drawn = drawNumbers();
      currentRound.drawnNumbers = drawn;

      // Evaluate tickets
      const winners = [];
      currentRound.tickets.forEach(ticket => {
        const matches = ticket.picks.filter(n => drawn.includes(n)).length;
        const multiplier = payouts[matches] ?? 0;
        if (multiplier > 0) {
          const winAmount = ticket.betAmount * multiplier;
          winners.push({ ticketId: ticket.ticketId, matches, winAmount });
        }
      });

      // Broadcast result to everyone with drawn numbers
      broadcast({ type: 'drawResult', roundId: currentRound.id, drawnNumbers: drawn });

      // Notify individual winners (in production, credit their accounts)
      winners.forEach(w => {
        const ticket = currentRound.tickets.find(t => t.ticketId === w.ticketId);
        if (ticket && ticket.ws.readyState === WebSocket.OPEN) {
          ticket.ws.send(JSON.stringify({
            type: 'youWon',
            ticketId: w.ticketId,
            matches: w.matches,
            winAmount: w.winAmount
          }));
        }
      });

      // Start next round after a short pause
      setTimeout(startRound, 10_000);
    }, DRAW_DELAY);
  }, ROUND_DURATION);
}

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// ---------- WebSocket Handlers ----------
wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'placeBet' && currentRound.status === 'accepting') {
        const { picks, betAmount } = data;

        // Validate: 1-10 numbers, all between 1-80, unique
        if (!picks || picks.length < 1 || picks.length > 10) {
          ws.send(JSON.stringify({ type: 'error', message: 'Pick 1 to 10 numbers.' }));
          return;
        }
        if (!betAmount || betAmount <= 0) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid bet.' }));
          return;
        }
        const validNumbers = picks.every(n => Number.isInteger(n) && n >= 1 && n <= 80);
        if (!validNumbers || new Set(picks).size !== picks.length) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid or duplicate numbers.' }));
          return;
        }

        // In production: check user balance, deduct bet
        const ticketId = crypto.randomUUID();
        currentRound.tickets.push({ ws, picks, betAmount, ticketId });

        ws.send(JSON.stringify({ type: 'betAccepted', ticketId, picks }));
        broadcast({ type: 'playerCount', count: currentRound.tickets.length });
      }
    } catch (e) {
      console.error('Invalid message', e);
    }
  });
});

// Start the first round
startRound();

server.listen(3000, () => console.log('Fast Keno server running on port 3000'));

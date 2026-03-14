const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// In-memory storage for game rooms
const rooms = {};

// Helper: generate 6-digit room code
function generateRoomCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Helper: create a shuffled 52-card deck
function createDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let suit of suits) {
        for (let rank of ranks) {
            deck.push({ suit, rank });
        }
    }
    // Fisher-Yates shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

// Helper: rank order for comparison (2 lowest, A highest)
const rankOrder = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// Helper: find player index by socket id
function findPlayerIndex(room, socketId) {
    return room.players.findIndex(p => p.id === socketId);
}

// Helper: deal initial 5 cards one by one to all players
function dealInitialCards(room) {
    for (let i = 0; i < 5; i++) {
        for (let p = 0; p < 4; p++) {
            const card = room.deck.pop();
            room.players[p].hand.push(card);
            io.to(room.players[p].id).emit('cardDealt', card);
        }
    }
}

// Helper: deal remaining cards (4 each round) until each player has 13 total
function dealRemainingCards(room) {
    const totalPerPlayer = 13;
    // Continue dealing until everyone has 13 cards (including power card holder, who will have 12 in hand + 1 power)
    while (room.players.some(p => p.hand.length < totalPerPlayer - (p.id === room.powerCardPlayer ? 1 : 0))) {
        for (let p = 0; p < 4; p++) {
            if (room.players[p].hand.length < totalPerPlayer - (p.id === room.powerCardPlayer ? 1 : 0)) {
                const card = room.deck.pop();
                room.players[p].hand.push(card);
                io.to(room.players[p].id).emit('cardDealt', card);
            }
        }
    }
    // After dealing, set phase to playing
    room.phase = 'playing';
    room.turnIndex = 0; // first player leads
    room.trick = { cards: [], leader: 0, suitLed: null };
    io.to(room.code).emit('playingPhase', { turn: room.turnIndex });
}

// Helper: evaluate trick winner
function evaluateTrick(trickCards, ledSuit, trumpSuit) {
    // trickCards = [{ card, playerIndex }]
    let winningIndex = trickCards[0].playerIndex;
    let winningCard = trickCards[0].card;
    let trumpPlayed = (winningCard.suit === trumpSuit);

    for (let i = 1; i < trickCards.length; i++) {
        const { card, playerIndex } = trickCards[i];
        const isTrump = (card.suit === trumpSuit);
        if (trumpPlayed) {
            // If trump already in trick, only higher trump wins
            if (isTrump && rankOrder.indexOf(card.rank) > rankOrder.indexOf(winningCard.rank)) {
                winningIndex = playerIndex;
                winningCard = card;
            }
        } else {
            // No trump yet
            if (isTrump) {
                // First trump wins
                trumpPlayed = true;
                winningIndex = playerIndex;
                winningCard = card;
            } else if (card.suit === ledSuit && rankOrder.indexOf(card.rank) > rankOrder.indexOf(winningCard.rank)) {
                // Same suit, higher rank
                winningIndex = playerIndex;
                winningCard = card;
            }
        }
    }
    return winningIndex;
}

// Helper: calculate round scores
function calculateRoundScore(room) {
    const callTeam = room.callTeam; // 0 for Team A, 1 for Team B
    const callValue = room.callValue;
    const tricksA = room.players.filter(p => p.team === 0).reduce((sum, p) => sum + p.tricksWon, 0);
    const tricksB = room.players.filter(p => p.team === 1).reduce((sum, p) => sum + p.tricksWon, 0);

    const callingTeamTricks = callTeam === 0 ? tricksA : tricksB;
    const opponentTeamTricks = callTeam === 0 ? tricksB : tricksA;

    let callScore = 0, oppScore = 0;

    if (callingTeamTricks >= callValue) {
        // Calling team succeeded
        callScore = callValue;
    } else {
        // Calling team failed
        callScore = -callValue;
        // Opponent gets 5 points if they took more than 5 tricks (as per example)
        if (opponentTeamTricks > 5) {
            oppScore = 5;
        }
    }

    room.scores[0] += (callTeam === 0 ? callScore : oppScore);
    room.scores[1] += (callTeam === 1 ? callScore : oppScore);

    // Check if any team reached target score
    if (room.scores[0] >= room.targetScore || room.scores[1] >= room.targetScore) {
        room.winner = room.scores[0] >= room.targetScore ? 0 : 1;
        io.to(room.code).emit('gameOver', { winner: room.winner, scores: room.scores });
    } else {
        // Start new round
        startNewRound(room);
    }
}

// Helper: start a new round
function startNewRound(room) {
    room.phase = 'calling';
    room.deck = createDeck();
    room.players.forEach(p => {
        p.hand = [];
        p.tricksWon = 0;
    });
    room.powerCard = null;
    room.powerCardPlayer = null;
    room.trumpSuit = null;
    room.trumpRevealed = false;
    room.trick = { cards: [], leader: 0, suitLed: null };
    room.tricksPlayed = 0;
    room.callValue = null;
    room.callTeam = null;

    dealInitialCards(room);
    room.currentCall = { currentPlayer: 0 };
    io.to(room.code).emit('callingPhase', { playerIndex: 0 });
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Create room
    socket.on('createRoom', ({ playerName, targetScore }) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            code: roomCode,
            players: [{
                id: socket.id,
                name: playerName,
                team: 0, // Player 1 = Team A
                hand: [],
                tricksWon: 0
            }],
            phase: 'lobby',
            targetScore: targetScore || 30,
            scores: [0, 0],
            currentCall: null,
            callValue: null,
            callTeam: null,
            powerCard: null,
            powerCardPlayer: null,
            trumpSuit: null,
            trumpRevealed: false,
            trick: { cards: [], leader: null, suitLed: null },
            tricksPlayed: 0,
            deck: [],
            turnIndex: 0,
            winner: null
        };
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode, playerIndex: 0 });
        io.to(roomCode).emit('playersUpdate', rooms[roomCode].players);
    });

    // Join room
    socket.on('joinRoom', ({ roomCode, playerName }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit('error', 'Room not found');
        if (room.players.length >= 4) return socket.emit('error', 'Room is full');
        if (room.phase !== 'lobby') return socket.emit('error', 'Game already started');

        const playerIndex = room.players.length;
        const team = playerIndex % 2 === 0 ? 0 : 1;
        room.players.push({
            id: socket.id,
            name: playerName,
            team,
            hand: [],
            tricksWon: 0
        });
        socket.join(roomCode);
        socket.emit('roomJoined', { roomCode, playerIndex });
        io.to(roomCode).emit('playersUpdate', room.players);

        if (room.players.length === 4) {
            startNewRound(room);
        }
    });

    // Make a call
    socket.on('makeCall', ({ roomCode, callValue, powerCard }) => {
        const room = rooms[roomCode];
        if (!room || room.phase !== 'calling') return;
        const playerIndex = findPlayerIndex(room, socket.id);
        if (playerIndex !== room.currentCall.currentPlayer) return; // not his turn

        if (callValue === 'Nil') {
            // Nil: move to next player, unless it's the last player (index 3) then force call 7
            if (playerIndex === 3) {
                // last player must call 7 (forced)
                // For simplicity, we'll make them call 7 automatically
                callValue = 7;
                // need to select a power card – but we don't have one. We'll handle later.
                // For now, we'll send an error and ask to select.
                socket.emit('error', 'You must call 7, 8, or 9. Please click a call button.');
                return;
            } else {
                // Move to next player
                room.currentCall.currentPlayer = (playerIndex + 1) % 4;
                io.to(roomCode).emit('callingPhase', { playerIndex: room.currentCall.currentPlayer });
                return;
            }
        } else {
            // 7, 8, or 9
            callValue = parseInt(callValue);
            // If there was a previous power card, return it to its owner
            if (room.powerCardPlayer !== null && room.powerCardPlayer !== playerIndex) {
                const prevPlayer = room.players[room.powerCardPlayer];
                if (room.powerCard) {
                    prevPlayer.hand.push(room.powerCard);
                    io.to(prevPlayer.id).emit('cardReturned', room.powerCard);
                }
            }
            // Remove selected power card from current player's hand
            const cardIndex = room.players[playerIndex].hand.findIndex(c =>
                c.suit === powerCard.suit && c.rank === powerCard.rank
            );
            if (cardIndex === -1) return;
            room.players[playerIndex].hand.splice(cardIndex, 1);

            // Set new call
            room.callValue = callValue;
            room.callTeam = playerIndex % 2 === 0 ? 0 : 1; // Team based on player
            room.powerCard = powerCard;
            room.powerCardPlayer = playerIndex;
            room.trumpSuit = null; // not yet revealed

            // Notify everyone of the call
            io.to(roomCode).emit('callMade', { playerIndex, callValue, powerCardPlayer: playerIndex });

            // Move to next player for possible raise
            room.currentCall.currentPlayer = (playerIndex + 1) % 4;

            // If we've gone full circle (next player is the first caller or all have passed?), we need to end calling phase
            // Simplified: after any call, we immediately proceed to dealing (in real game, others can raise)
            // For full raise logic, we'd need more states. We'll simplify: after one call, proceed.
            room.phase = 'dealing';
            dealRemainingCards(room);
        }
    });

    // Play a card
    socket.on('playCard', ({ roomCode, card }) => {
        const room = rooms[roomCode];
        if (!room || room.phase !== 'playing') return;
        const playerIndex = findPlayerIndex(room, socket.id);
        if (playerIndex !== room.turnIndex) return;

        // Remove card from hand
        const cardIndex = room.players[playerIndex].hand.findIndex(c =>
            c.suit === card.suit && c.rank === card.rank
        );
        if (cardIndex === -1) return;
        room.players[playerIndex].hand.splice(cardIndex, 1);

        // If this is the first card of the trick, set suitLed
        if (room.trick.cards.length === 0) {
            room.trick.suitLed = card.suit;
            room.trick.leader = playerIndex;
        }

        // Add to trick
        room.trick.cards.push({ card, playerIndex });

        // Broadcast played card
        io.to(roomCode).emit('cardPlayed', { playerIndex, card, trick: room.trick.cards });

        // If trick is complete (4 cards)
        if (room.trick.cards.length === 4) {
            // Evaluate winner
            const winnerIndex = evaluateTrick(room.trick.cards, room.trick.suitLed, room.trumpSuit);
            room.players[winnerIndex].tricksWon++;
            io.to(roomCode).emit('trickWon', { winnerIndex, tricks: room.players.map(p => p.tricksWon) });

            room.tricksPlayed++;
            if (room.tricksPlayed === 13) {
                // Round over
                calculateRoundScore(room);
            } else {
                // Next trick: winner leads
                room.trick = { cards: [], leader: winnerIndex, suitLed: null };
                room.turnIndex = winnerIndex;
                io.to(roomCode).emit('nextTrick', { leader: winnerIndex });
            }
        } else {
            // Next player
            room.turnIndex = (playerIndex + 1) % 4;
            io.to(roomCode).emit('turnUpdate', { turn: room.turnIndex });
        }
    });

    // Restart game
    socket.on('restartGame', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;
        room.scores = [0, 0];
        room.winner = null;
        startNewRound(room);
    });

    // Disconnect
    socket.on('disconnect', () => {
        for (let code in rooms) {
            const room = rooms[code];
            const index = findPlayerIndex(room, socket.id);
            if (index !== -1) {
                // Remove player
                room.players.splice(index, 1);
                io.to(code).emit('playersUpdate', room.players);
                if (room.players.length === 0) {
                    delete rooms[code];
                } else {
                    // Reset game if in progress
                    room.phase = 'lobby';
                    // Optionally notify others
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
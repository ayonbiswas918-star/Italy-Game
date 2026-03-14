const socket = io();

let currentRoom = null;
let playerIndex = null;
let myHand = [];
let players = [];
let targetScore = 30;
let isMyTurn = false;
let trumpRevealed = false;
let trumpSuit = null;
let powerCard = null;

// DOM elements
const loginScreen = document.getElementById('login-screen');
const gameScreen = document.getElementById('game-screen');
const createBtn = document.getElementById('create-room');
const joinBtn = document.getElementById('join-room');
const playerNameInput = document.getElementById('player-name');
const roomCodeInput = document.getElementById('room-code');
const targetSelect = document.getElementById('target-score');
const displayRoomCode = document.getElementById('display-room-code');
const scoreA = document.getElementById('score-a');
const scoreB = document.getElementById('score-b');
const trickCounter = document.getElementById('trick-counter');
const trumpStatus = document.getElementById('trump-status');
const restartBtn = document.getElementById('restart-game');
const callingControls = document.getElementById('calling-controls');

const handElements = [
    document.getElementById('hand-0'),
    document.getElementById('hand-1'),
    document.getElementById('hand-2'),
    document.getElementById('hand-3')
];
const playerNameElements = [
    document.querySelector('#player-0 .player-name'),
    document.querySelector('#player-1 .player-name'),
    document.querySelector('#player-2 .player-name'),
    document.querySelector('#player-3 .player-name')
];
const trickElements = [
    document.querySelector('#player-0 .tricks'),
    document.querySelector('#player-1 .tricks'),
    document.querySelector('#player-2 .tricks'),
    document.querySelector('#player-3 .tricks')
];

const soundDeal = document.getElementById('sound-deal');
const soundPlay = document.getElementById('sound-play');
const soundWin = document.getElementById('sound-win');

// ---------- Socket event handlers ----------
socket.on('roomCreated', ({ roomCode, playerIndex: idx }) => {
    currentRoom = roomCode;
    playerIndex = idx;
    displayRoomCode.innerText = roomCode;
    showGameScreen();
});

socket.on('roomJoined', ({ roomCode, playerIndex: idx }) => {
    currentRoom = roomCode;
    playerIndex = idx;
    displayRoomCode.innerText = roomCode;
    showGameScreen();
});

socket.on('playersUpdate', (updatedPlayers) => {
    players = updatedPlayers;
    updatePlayerNames();
});

socket.on('callingPhase', ({ playerIndex: turn }) => {
    isMyTurn = (turn === playerIndex);
    if (isMyTurn) {
        callingControls.classList.remove('hidden');
    } else {
        callingControls.classList.add('hidden');
    }
});

socket.on('cardDealt', (card) => {
    myHand.push(card);
    renderMyHand();
    playSound(soundDeal);
});

socket.on('cardReturned', (card) => {
    myHand.push(card);
    renderMyHand();
});

socket.on('callMade', ({ playerIndex: caller, callValue, powerCardPlayer }) => {
    // Optionally show who called what
    if (powerCardPlayer !== undefined) {
        // The power card is now with that player; others see face-down
    }
    if (caller === playerIndex) {
        callingControls.classList.add('hidden');
    }
});

socket.on('playingPhase', ({ turn }) => {
    isMyTurn = (turn === playerIndex);
    trumpStatus.innerText = trumpRevealed ? trumpSuit : '❓';
});

socket.on('cardPlayed', ({ playerIndex: pIdx, card, trick }) => {
    // Update trick display
    renderTrick(trick);
    // Remove card from that player's hand display
    if (pIdx === playerIndex) {
        // Already removed locally? We'll rely on server sync, but we can update hand
        // In a full implementation, we'd sync entire hand state from server.
    }
    playSound(soundPlay);
});

socket.on('turnUpdate', ({ turn }) => {
    isMyTurn = (turn === playerIndex);
    // highlight current player
});

socket.on('trickWon', ({ winnerIndex, tricks }) => {
    // Update tricks display for all players
    players.forEach((p, i) => {
        p.tricksWon = tricks[i];
        trickElements[i].innerText = `Tricks: ${tricks[i]}`;
    });
    playSound(soundWin);
});

socket.on('nextTrick', ({ leader }) => {
    // Clear trick display
    document.getElementById('trick-cards').innerHTML = '';
    isMyTurn = (leader === playerIndex);
});

socket.on('gameOver', ({ winner, scores }) => {
    alert(`Team ${winner === 0 ? 'A' : 'B'} wins!`);
    restartBtn.style.display = 'inline-block';
});

socket.on('error', (msg) => {
    alert(msg);
});

// ---------- UI functions ----------
function showGameScreen() {
    loginScreen.classList.add('hidden');
    gameScreen.classList.remove('hidden');
}

function updatePlayerNames() {
    players.forEach((p, i) => {
        playerNameElements[i].innerText = p.name + (p.team === 0 ? ' (A)' : ' (B)');
    });
}

function renderMyHand() {
    const handDiv = handElements[playerIndex];
    handDiv.innerHTML = '';
    myHand.forEach((card, idx) => {
        const cardDiv = document.createElement('div');
        cardDiv.className = `card ${card.suit === '♥' || card.suit === '♦' ? 'red' : 'black'}`;
        cardDiv.innerText = `${card.rank}${card.suit}`;
        cardDiv.draggable = true;
        cardDiv.setAttribute('data-index', idx);
        cardDiv.addEventListener('dragstart', handleDragStart);
        cardDiv.addEventListener('dragend', handleDragEnd);
        handDiv.appendChild(cardDiv);
    });
}

function renderTrick(trickCards) {
    const trickDiv = document.getElementById('trick-cards');
    trickDiv.innerHTML = '';
    trickCards.forEach(({ card }) => {
        const cardDiv = document.createElement('div');
        cardDiv.className = `card ${card.suit === '♥' || card.suit === '♦' ? 'red' : 'black'}`;
        cardDiv.innerText = `${card.rank}${card.suit}`;
        trickDiv.appendChild(cardDiv);
    });
}

// Drag and drop
let draggedCard = null;
function handleDragStart(e) {
    draggedCard = e.target;
    e.target.classList.add('dragging');
    e.dataTransfer.setData('text/plain', e.target.innerText);
}
function handleDragEnd(e) {
    e.target.classList.remove('dragging');
    draggedCard = null;
}

// Click to play (for mobile)
handElements[playerIndex]?.addEventListener('click', (e) => {
    const cardDiv = e.target.closest('.card');
    if (!cardDiv || !isMyTurn) return;
    const index = cardDiv.dataset.index;
    if (index !== undefined) {
        const card = myHand[index];
        socket.emit('playCard', { roomCode: currentRoom, card });
        // Optimistically remove from UI
        myHand.splice(index, 1);
        renderMyHand();
    }
});

// Calling buttons
document.querySelectorAll('.call-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const call = btn.dataset.call;
        if (call === 'Nil') {
            socket.emit('makeCall', { roomCode: currentRoom, callValue: 'Nil' });
        } else {
            // Need to select a power card
            alert('Click on the card you want as Power Card');
            window.selectingPowerCardForCall = parseInt(call);
        }
    });
});

// Power card selection
handElements[playerIndex]?.addEventListener('click', function powerCardSelector(e) {
    const callValue = window.selectingPowerCardForCall;
    if (callValue && e.target.closest('.card')) {
        const cardDiv = e.target.closest('.card');
        const index = cardDiv.dataset.index;
        const card = myHand[index];
        socket.emit('makeCall', {
            roomCode: currentRoom,
            callValue,
            powerCard: card
        });
        // Remove from hand
        myHand.splice(index, 1);
        renderMyHand();
        window.selectingPowerCardForCall = null;
    }
});

// Restart button
restartBtn.addEventListener('click', () => {
    socket.emit('restartGame', { roomCode: currentRoom });
    restartBtn.style.display = 'none';
});

// Create room
createBtn.addEventListener('click', () => {
    const name = playerNameInput.value.trim() || 'Player';
    targetScore = parseInt(targetSelect.value);
    socket.emit('createRoom', { playerName: name, targetScore });
});

// Join room
joinBtn.addEventListener('click', () => {
    const name = playerNameInput.value.trim() || 'Player';
    const code = roomCodeInput.value.trim();
    if (code) {
        socket.emit('joinRoom', { roomCode: code, playerName: name });
    }
});

function playSound(audioElement) {
    if (audioElement) audioElement.play().catch(e => {});
}
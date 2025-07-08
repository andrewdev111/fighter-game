# Fighting Game - Retro WebSocket Multiplayer

## Overview

A real-time multiplayer fighting game with optimized networking for maximum synchronization and minimal latency. The game features a three-step flow for matchmaking.

## Game Flow

### 1. Character Selection

- Choose your fighter: **Dowand** (Red) or **Ewon** (Blue)
- Each character has unique visual design and starting position
- Must select character before proceeding to game modes

### 2. Game Mode Selection

- **⚡ Quick Match**: Automatic matchmaking with random online players
  - FIFO queue system for fair matching
  - Automatic game start when opponent found
- **🔒 Private Room**: Play with friends using room codes
  - Create room and share code with friends
  - Manual ready system for synchronized start

### 3. Waiting/Game Screen

- **Queue Mode**: Real-time search timer and status
- **Room Mode**: Waiting for opponent and ready confirmation
- **Game**: Live multiplayer fighting with 60 FPS synchronization

## Features

### Networking

- **60 FPS server tick rate** for smooth real-time gameplay
- **WebSocket without compression** for speed optimization
- **Linear interpolation** (0.3 factor) for smooth player movement
- **Server-side validation** and anti-cheat protection
- **Heartbeat system** (30s) for connection stability
- **Automatic reconnection** on disconnect
- **Real-time ping monitoring** and player count display

### Game Mechanics

- **Two unique fighters** with different stats and positions
- **Movement**: Arrow keys or WASD for movement and jumping
- **Combat**: Arm strikes, leg strikes, shooting, and blocking
- **Health system** with visual health bars
- **Projectile system** with collision detection
- **Real-time damage and status effects**

### UI/UX

- **Three-screen progression** for better user experience
- **Visual character cards** with fighter previews
- **Real-time connection status** and network information
- **Queue timer** showing search duration
- **Modern game UI** with retro pixel art style
- **Responsive design** for different screen sizes

## Technical Architecture

### Server (Node.js + WebSocket)

```javascript
// Core game loop runs at 60 FPS
this.tickInterval = 1000 / 60; // 16.67ms per tick

// Queue system with automatic matching
tryCreateMatch() {
  if (gameState.queue.length >= 2) {
    // Create room and start game automatically
  }
}
```

### Client (HTML5 + Canvas)

```javascript
// Three-screen navigation
1. Character Selection → 2. Game Mode → 3. Waiting → 4. Game

// Real-time networking with interpolation
function updateNetworkPlayers(message) {
  // Smooth player movement synchronization
}
```

## API Documentation

### WebSocket Messages

#### Client → Server

```json
// Character selection (step 1)
{"type": "selectFighter", "fighter": "dowand|ewon"}

// Queue system (step 2a)
{"type": "joinQueue"}
{"type": "leaveQueue"}

// Private rooms (step 2b)
{"type": "createRoom"}
{"type": "joinRoom", "roomId": number}
{"type": "ready"}

// Game input
{"type": "playerInput", "input": {...}, "timestamp": number}
```

#### Server → Client

```json
// Connection
{"type": "connected", "playerId": number}

// Matchmaking
{"type": "queueJoined", "position": number}
{"type": "matchFound", "roomId": number, "opponent": number}

// Room management
{"type": "roomCreated", "roomId": number}
{"type": "roomJoined", "roomId": number}

// Game states
{"type": "gameStart", "players": [...]}
{"type": "gameUpdate", "timestamp": number, "players": [...]}
```

## Installation & Setup

### Prerequisites

- Node.js 14+
- Modern web browser with WebSocket support

### Server Setup

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Start production server
npm start
```

### Client Access

1. Open `http://localhost:3000` in your browser
2. Select your fighter (Dowand or Ewon)
3. Choose game mode (Quick Match or Private Room)
4. Wait for opponent and start fighting!

## Game Flow Example

### Quick Match Flow

```
Player A: Select Dowand → Quick Match → Queue (5s) → Match Found → Game Start
Player B: Select Ewon → Quick Match → Queue (2s) → Match Found → Game Start
```

### Private Room Flow

```
Player A: Select Dowand → Create Room → Room 1234 → Ready → Waiting...
Player B: Select Ewon → Join Room 1234 → Ready → Game Start!
```

## Performance Optimizations

- **No WebSocket compression** for minimal latency
- **60 Hz server updates** for smooth gameplay
- **Client-side prediction** with server reconciliation
- **Efficient state synchronization** with delta compression
- **Connection pooling** and heartbeat monitoring
- **Automatic cleanup** of disconnected players and empty rooms

## Development

### File Structure

```
├── server.js          # WebSocket game server
├── index.html         # Game client with three-screen UI
├── package.json       # Dependencies and scripts
├── assets/           # Game sprites and images
└── README.md         # This documentation
```

### Key Classes

- **GameRoom**: Manages multiplayer sessions and game logic
- **Player**: Handles fighter mechanics and networking
- **WebSocket Server**: Real-time communication and matchmaking

The game is designed for maximum multiplayer performance with modern web technologies and optimized networking protocols.

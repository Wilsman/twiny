// Initialize upgrade testing when the page loads
// This script should be included in streamer.html

import { initUpgradeTesting } from '/common.js';

// Wait for DOM and WebSocket to be ready
function initWhenReady() {
  // Check if elements exist
  const upgradeTestPanel = document.getElementById("upgradeTestPanel");
  if (!upgradeTestPanel) {
    console.log('Upgrade test panel not found, retrying...');
    setTimeout(initWhenReady, 500);
    return;
  }

  // Check if WebSocket is available (look for global variables)
  if (typeof window.ws === 'undefined' || !window.ws) {
    console.log('WebSocket not ready, retrying...');
    setTimeout(initWhenReady, 500);
    return;
  }

  // Check if game state is available
  if (typeof window.gameState === 'undefined') {
    // Create a basic game state object
    window.gameState = { gameMode: 'normal' };
  }

  // Initialize upgrade testing
  console.log('Initializing upgrade testing...');
  const upgradeTestingAPI = initUpgradeTesting(window.ws, window.gameState);
  
  if (upgradeTestingAPI) {
    // Store globally for access
    window.upgradeTestingAPI = upgradeTestingAPI;
    console.log('Upgrade testing initialized successfully');
  } else {
    console.warn('Failed to initialize upgrade testing');
  }
}

// Start initialization when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initWhenReady);
} else {
  initWhenReady();
}

// Also try to detect when we enter testing mode
function detectTestingMode() {
  // Look for URL parameters or other indicators
  const urlParams = new URLSearchParams(window.location.search);
  const roomId = urlParams.get('room');
  
  if (roomId && window.upgradeTestingAPI) {
    // Check if we're in testing mode by looking at game state
    // This might need to be updated based on how the game state is managed
    setTimeout(() => {
      if (window.gameState && window.gameState.gameMode === 'testing') {
        window.upgradeTestingAPI.updateVisibility();
      }
    }, 1000);
  }
}

// Monitor for testing mode changes
setInterval(detectTestingMode, 2000);

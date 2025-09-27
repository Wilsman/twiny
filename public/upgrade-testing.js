// Upgrade Testing Functionality for Testing Mode
// This module handles the upgrade testing panel in the sidebar

// All available upgrades from the server
const ALL_UPGRADES = [
  {
    id: "damage_up",
    name: "+15% Damage",
    rarity: "common",
    desc: "All weapons deal 15% more damage.",
  },
  {
    id: "firerate_up",
    name: "+20% Fire Rate",
    rarity: "common",
    desc: "Shoot faster.",
  },
  {
    id: "bullet_size",
    name: "Bigger Bullets",
    rarity: "uncommon",
    desc: "+20% bullet size per stack.",
  },
  {
    id: "spread_down",
    name: "Tighter Spread",
    rarity: "uncommon",
    desc: "-15% spread.",
  },
  {
    id: "pierce",
    name: "Piercing",
    rarity: "rare",
    desc: "+1 pierce per stack.",
  },
  {
    id: "bounce",
    name: "Bouncy Bullets",
    rarity: "rare",
    desc: "+1 wall bounce.",
  },
  {
    id: "crit_chance",
    name: "Criticals",
    rarity: "rare",
    desc: "+10% crit chance (+50% crit dmg).",
  },
  {
    id: "crit_dmg",
    name: "Critical Damage",
    rarity: "rare",
    desc: "+50% crit damage.",
  },
  {
    id: "status_burn",
    name: "Incendiary",
    rarity: "rare",
    desc: "Bullets have 15% to ignite (12 DPS for 3s).",
  },
  {
    id: "status_slow",
    name: "Cryo Rounds",
    rarity: "uncommon",
    desc: "15% chance to slow (40% for 2s).",
  },
  {
    id: "lifesteal",
    name: "Lifesteal",
    rarity: "epic",
    desc: "Heal 2% of damage dealt.",
  },
  {
    id: "reload_on_kill",
    name: "Adrenaline",
    rarity: "epic",
    desc: "Refund 10% ammo on kill.",
  },
  {
    id: "on_hit_explode",
    name: "Micro-grenades",
    rarity: "epic",
    desc: "Small explosion on hit.",
  },
  {
    id: "chain_lightning",
    name: "Storm Chorus",
    rarity: "rare",
    desc: "On-hit chance to arc stormlight between foes.",
  },
  {
    id: "void_hooks",
    name: "Umbral Net",
    rarity: "epic",
    desc: "Impact points lash nearby zombies toward the strike.",
  },
  {
    id: "volatile_payload",
    name: "Volatile Payload",
    rarity: "epic",
    desc: "Killing blows may detonate the target.",
  },
  {
    id: "sanguine_cycle",
    name: "Sanguine Cycle",
    rarity: "uncommon",
    desc: "Chance to siphon a surge of health on hit.",
  },
  {
    id: "extra_bullet",
    name: "Double Tap",
    rarity: "uncommon",
    desc: "Each shot fires one extra projectile per stack without consuming ammo.",
  },
  {
    id: "ammo_efficiency",
    name: "Ammo Saver",
    rarity: "uncommon",
    desc: "Shots cost 10% less ammo.",
  },
  {
    id: "magnet_radius",
    name: "Loot Vacuum",
    rarity: "common",
    desc: "+40px pickup radius UI hint.",
  },
  {
    id: "movement_speed",
    name: "Swift Feet",
    rarity: "common",
    desc: "+25% movement speed.",
  },
  {
    id: "dash_distance",
    name: "Long Dash",
    rarity: "uncommon",
    desc: "+50% dash distance.",
  },
  {
    id: "double_jump",
    name: "Air Walker",
    rarity: "rare",
    desc: "Dash resets on kill (simulates double jump).",
  },
  {
    id: "ghost_walk",
    name: "Phase Step",
    rarity: "epic",
    desc: "Brief invulnerability after dash (0.5s).",
  },
  {
    id: "elemental_trail",
    name: "Elemental Wake",
    rarity: "rare",
    desc: "Movement leaves elemental trails that scorch, poison, or shock foes.",
  },
  {
    id: "berserker",
    name: "Berserker Rage",
    rarity: "rare",
    desc: "+10% damage per recent kill (max 5 stacks).",
  },
  {
    id: "vampire_aura",
    name: "Blood Aura",
    rarity: "epic",
    desc: "Heal from nearby zombie deaths (+50px range).",
  },
  {
    id: "time_dilation",
    name: "Bullet Time",
    rarity: "legendary",
    desc: "Slow time on low health (2s duration).",
  },
  {
    id: "bullet_time",
    name: "Matrix Mode",
    rarity: "legendary",
    desc: "Slow projectiles when dashing (1s).",
  },
  {
    id: "explosive_death",
    name: "Martyrdom",
    rarity: "rare",
    desc: "Explode on death dealing 50 damage.",
  },
  {
    id: "shield_regen",
    name: "Auto-Repair",
    rarity: "uncommon",
    desc: "Regenerate 1 HP every 3 seconds.",
  },
];

// Track current upgrade counts
let currentUpgrades = {};

// Initialize upgrade testing functionality
export function initUpgradeTesting(ws, gameMode) {
  const upgradeTestPanel = document.getElementById("upgradeTestPanel");
  const upgradeTestList = document.getElementById("upgradeTestList");
  const upgradeSearch = document.getElementById("upgradeSearch");

  if (!upgradeTestPanel || !upgradeTestList || !upgradeSearch) {
    console.warn("Upgrade testing elements not found");
    return;
  }

  // Show/hide panel based on game mode
  if (gameMode === 'testing') {
    upgradeTestPanel.style.display = 'block';
    populateUpgradeList();
    setupSearchFilter();
  } else {
    upgradeTestPanel.style.display = 'none';
  }

  function populateUpgradeList() {
    upgradeTestList.innerHTML = '';
    
    ALL_UPGRADES.forEach(upgrade => {
      const count = currentUpgrades[upgrade.id] || 0;
      const item = createUpgradeItem(upgrade, count);
      upgradeTestList.appendChild(item);
    });
  }

  function createUpgradeItem(upgrade, count) {
    const item = document.createElement('div');
    item.className = `upgrade-test-item ${upgrade.rarity}`;
    item.dataset.upgradeId = upgrade.id;
    
    item.innerHTML = `
      <div class="upgrade-test-info">
        <div class="upgrade-test-name">${upgrade.name}</div>
        <div class="upgrade-test-desc">${upgrade.desc}</div>
      </div>
      <div class="upgrade-test-controls">
        <button class="upgrade-test-btn" data-action="remove" ${count === 0 ? 'disabled' : ''}>−</button>
        <div class="upgrade-test-count">${count}</div>
        <button class="upgrade-test-btn" data-action="add">+</button>
      </div>
    `;

    // Add click handlers
    const addBtn = item.querySelector('[data-action="add"]');
    const removeBtn = item.querySelector('[data-action="remove"]');
    const countEl = item.querySelector('.upgrade-test-count');

    addBtn.addEventListener('click', () => {
      applyUpgrade(upgrade.id);
      currentUpgrades[upgrade.id] = (currentUpgrades[upgrade.id] || 0) + 1;
      countEl.textContent = currentUpgrades[upgrade.id];
      removeBtn.disabled = false;
    });

    removeBtn.addEventListener('click', () => {
      if (currentUpgrades[upgrade.id] > 0) {
        removeUpgrade(upgrade.id);
        currentUpgrades[upgrade.id]--;
        countEl.textContent = currentUpgrades[upgrade.id];
        if (currentUpgrades[upgrade.id] === 0) {
          removeBtn.disabled = true;
        }
      }
    });

    return item;
  }

  function setupSearchFilter() {
    upgradeSearch.addEventListener('input', (e) => {
      const searchTerm = e.target.value.toLowerCase();
      const items = upgradeTestList.querySelectorAll('.upgrade-test-item');
      
      items.forEach(item => {
        const name = item.querySelector('.upgrade-test-name').textContent.toLowerCase();
        const desc = item.querySelector('.upgrade-test-desc').textContent.toLowerCase();
        const matches = name.includes(searchTerm) || desc.includes(searchTerm);
        item.style.display = matches ? 'flex' : 'none';
      });
    });
  }

  function applyUpgrade(upgradeId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket not connected');
      return;
    }

    // Send upgrade application to server
    ws.send(JSON.stringify({
      type: 'apply_upgrade_test',
      upgradeId: upgradeId
    }));

    console.log(`Applied upgrade: ${upgradeId}`);
  }

  function removeUpgrade(upgradeId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket not connected');
      return;
    }

    // Send upgrade removal to server
    ws.send(JSON.stringify({
      type: 'remove_upgrade_test',
      upgradeId: upgradeId
    }));

    console.log(`Removed upgrade: ${upgradeId}`);
  }

  // Reset upgrades when round restarts
  function resetUpgrades() {
    currentUpgrades = {};
    populateUpgradeList();
  }

  // Expose reset function globally
  window.resetTestingUpgrades = resetUpgrades;

  return {
    populateUpgradeList,
    resetUpgrades
  };
}

// Auto-initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  // Wait for WebSocket to be available
  setTimeout(() => {
    if (window.ws && window.gameState) {
      initUpgradeTesting(window.ws, window.gameState.gameMode);
    }
  }, 1000);
});

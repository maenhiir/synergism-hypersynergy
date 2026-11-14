// Where each screenshot goes on the website (docs/res/<to>@2x.webp) and its crop, in the shot's pixels (2x).
// The names are those of game-shots.cjs, plus steam-loader (loader-shot.cjs).
module.exports = {
    'mod-panel': { to: 'features/mod-panel' },
    // Getting started: down to "Don't switch ambrosia loadouts" (Advanced isn't needed there)
    'autosing-settings': { to: 'guides/autosing-settings', crop: [0, 0, 1120, 1420] },
    'header-edit': { to: 'features/header-edit' },
    'gq-search': { to: 'features/gq-search' },
    'hepteract-distributor': { to: 'features/hepteract-distributor' },
    'heater-results': { to: 'features/heater-results' },
    'strategy-window': { to: 'guides/strategy-window' },
    'actions-window': { to: 'guides/actions-window' },
    'if-jump': { to: 'guides/if-jump' },
    'autosing-window': { to: 'guides/autosing-window' },
    'step-timings': { to: 'guides/step-timings' },
    'steam-loader': { to: 'features/steam-loader' },
}

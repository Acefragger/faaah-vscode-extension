'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// --- Web Audio FAAAH generator via a hidden webview panel ---
let audioPanel = null;
let lastFaaahTime = 0;
let lastErrorCount = 0;

function activate(context) {
  console.log('FAAAH extension activated');

  // Initialize the audio webview (hidden, persistent)
  initAudioPanel(context);

  // Watch diagnostics (syntax errors, linter errors, etc.)
  const diagnosticListener = vscode.languages.onDidChangeDiagnostics((event) => {
    if (!getConfig().enabled) return;
    handleDiagnosticChange(event.uris);
  });

  // Watch terminal output for error keywords
  const terminalListener = vscode.window.onDidWriteTerminalData((event) => {
    if (!getConfig().enabled) return;
    handleTerminalOutput(event.data);
  });

  // Commands
  const toggleCmd = vscode.commands.registerCommand('faaah.toggle', () => {
    const cfg = vscode.workspace.getConfiguration('faaah');
    const current = cfg.get('enabled');
    cfg.update('enabled', !current, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`FAAAH sounds ${!current ? 'enabled 🔊' : 'disabled 🔇'}`);
  });

  const testCmd = vscode.commands.registerCommand('faaah.test', () => {
    playFaaah(3);
  });

  context.subscriptions.push(diagnosticListener, terminalListener, toggleCmd, testCmd);
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('faaah');
  return {
    enabled: cfg.get('enabled', true),
    baseDuration: cfg.get('baseDuration', 600),
    volume: cfg.get('volume', 0.8),
    cooldownMs: cfg.get('cooldownMs', 2000),
  };
}

// --- DIAGNOSTIC WATCHER ---
function handleDiagnosticChange(uris) {
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const uri of uris) {
    const diags = vscode.languages.getDiagnostics(uri);
    for (const d of diags) {
      if (d.severity === vscode.DiagnosticSeverity.Error) totalErrors++;
      else if (d.severity === vscode.DiagnosticSeverity.Warning) totalWarnings++;
    }
  }

  // Also count across ALL open files
  const allDiags = vscode.languages.getDiagnostics();
  let allErrors = 0;
  for (const [, diags] of allDiags) {
    for (const d of diags) {
      if (d.severity === vscode.DiagnosticSeverity.Error) allErrors++;
    }
  }

  // Only FAAAH if errors increased
  if (allErrors > 0 && allErrors >= lastErrorCount) {
    const newErrors = Math.max(allErrors - lastErrorCount, 1);
    triggerFaaah(allErrors);
  }

  lastErrorCount = allErrors;
}

// --- TERMINAL WATCHER ---
const ERROR_PATTERNS = [
  /error[\s:]/i,
  /exception[\s:]/i,
  /fatal[\s:]/i,
  /failed[\s:]/i,
  /cannot find/i,
  /\berror\b/i,
  /\bERROR\b/,
  /SyntaxError/,
  /TypeError/,
  /ReferenceError/,
  /npm ERR!/,
  /ENOENT/,
  /segmentation fault/i,
  /compilation failed/i,
  /build failed/i,
];

let terminalErrorBuffer = '';
let terminalDebounce = null;

function handleTerminalOutput(data) {
  terminalErrorBuffer += data;

  clearTimeout(terminalDebounce);
  terminalDebounce = setTimeout(() => {
    const lines = terminalErrorBuffer.split('\n');
    let errorLines = 0;

    for (const line of lines) {
      for (const pattern of ERROR_PATTERNS) {
        if (pattern.test(line)) {
          errorLines++;
          break;
        }
      }
    }

    if (errorLines > 0) {
      triggerFaaah(errorLines);
    }

    terminalErrorBuffer = '';
  }, 300);
}

// --- FAAAH TRIGGER ---
function triggerFaaah(errorCount) {
  const now = Date.now();
  const config = getConfig();

  if (now - lastFaaahTime < config.cooldownMs) return;
  lastFaaahTime = now;

  playFaaah(errorCount);
}

function playFaaah(errorCount) {
  const config = getConfig();
  if (!audioPanel) return;

  // Duration scales with error count: 1 error = base, 5+ errors = 3x base
  const multiplier = Math.min(1 + (errorCount - 1) * 0.4, 3.0);
  const duration = Math.round(config.baseDuration * multiplier);

  audioPanel.webview.postMessage({
    command: 'play',
    duration,
    volume: config.volume,
    errorCount,
  });
}

// --- HIDDEN AUDIO WEBVIEW ---
function initAudioPanel(context) {
  audioPanel = vscode.window.createWebviewPanel(
    'faaahAudio',
    'FAAAH Audio',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  // Immediately hide it by revealing another column — trick: just keep it background
  audioPanel.webview.html = getAudioWebviewHtml();

  audioPanel.onDidDispose(() => {
    // Recreate if disposed
    audioPanel = null;
    setTimeout(() => initAudioPanel(context), 500);
  }, null, context.subscriptions);
}

function getAudioWebviewHtml() {
  return `<!DOCTYPE html>
<html>
<head><title>FAAAH</title></head>
<body>
<script>
  const vscode = acquireVsCodeApi();

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.command === 'play') {
      playFaaah(msg.duration, msg.volume, msg.errorCount);
    }
  });

  function playFaaah(duration, volume, errorCount) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();

      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      const distortion = ctx.createWaveShaper();

      // Distortion for that raw "FAAAH" quality
      distortion.curve = makeDistortionCurve(150);
      distortion.oversample = '4x';

      osc.connect(distortion);
      distortion.connect(gainNode);
      gainNode.connect(ctx.destination);

      const now = ctx.currentTime;
      const dur = duration / 1000;

      // FAAAH pitch: starts mid, drops with a whine
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.linearRampToValueAtTime(160, now + dur * 0.3);
      osc.frequency.linearRampToValueAtTime(100, now + dur * 0.7);
      osc.frequency.linearRampToValueAtTime(80, now + dur);

      // Volume envelope: quick attack, long sustain, fade out
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(volume, now + 0.05);
      gainNode.gain.setValueAtTime(volume, now + dur * 0.6);
      gainNode.gain.linearRampToValueAtTime(0, now + dur);

      osc.start(now);
      osc.stop(now + dur);

      // For multiple errors, add a second layered tone
      if (errorCount >= 3) {
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);

        osc2.type = 'square';
        osc2.frequency.setValueAtTime(110, now + 0.1);
        osc2.frequency.linearRampToValueAtTime(80, now + dur);

        gain2.gain.setValueAtTime(0, now + 0.1);
        gain2.gain.linearRampToValueAtTime(volume * 0.3, now + 0.2);
        gain2.gain.linearRampToValueAtTime(0, now + dur);

        osc2.start(now + 0.1);
        osc2.stop(now + dur);
      }

    } catch(e) {
      console.error('FAAAH audio error:', e);
    }
  }

  function makeDistortionCurve(amount) {
    const n = 256;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }
</script>
<p style="font-family:monospace;color:#555;font-size:11px;">FAAAH Audio Engine — keep this tab open</p>
</body>
</html>`;
}

function deactivate() {}

module.exports = { activate, deactivate };
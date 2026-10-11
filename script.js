/**
 * ============================================================================
 * AbyssLink - Submarine Cable Protection Dashboard Controller
 * Pure Vanilla JavaScript with Native Web Serial API
 * ============================================================================
 */

(function () {
  'use strict';

  // --------------------------------------------------------------------------
  // Application State
  // --------------------------------------------------------------------------
  const state = {
    // Serial Connection
    isSerialSupported: 'serial' in navigator,
    port: null,
    reader: null,
    writer: null,
    readableStreamClosed: null,
    writableStreamClosed: null,
    keepReading: false,
    connectionState: 'DISCONNECTED', // DISCONNECTED, CONNECTING, CONNECTED, ERROR

    // Transmission & Hardware
    isTransmissionActive: false,
    isCommandPending: false,
    commandPendingTimeoutId: null,

    // Telemetry & Timing
    lastPacketTimestamp: null,
    staleCheckTimerId: null,
    isDataStale: false,

    // Last known sensor readings (for state transition logging)
    lastTelemetry: {
      transmission: null,
      ldr: null,
      vibration: null,
      distance_cm: null,
      distance_valid: null,
      laser: null,
      buzzer: null,
      alert: null
    },

    // Event Log (max 50 events in memory)
    events: []
  };

  const MAX_EVENTS = 50;
  const STALE_DATA_TIMEOUT_MS = 2000;

  // --------------------------------------------------------------------------
  // DOM Elements Cache
  // --------------------------------------------------------------------------
  const dom = {
    unsupportedBanner: document.getElementById('unsupportedBanner'),

    // Header & Connection
    connectBtn: document.getElementById('connectBtn'),
    disconnectBtn: document.getElementById('disconnectBtn'),
    connectionIndicatorDot: document.getElementById('connectionIndicatorDot'),
    connectionStatusLabel: document.getElementById('connectionStatusLabel'),

    // Transmission Card
    transmissionControlCard: document.getElementById('transmissionControlCard'),
    transmissionBadge: document.getElementById('transmissionBadge'),
    transmissionStatusVal: document.getElementById('transmissionStatusVal'),
    laserStateBox: document.getElementById('laserStateBox'),
    laserDot: document.getElementById('laserDot'),
    laserStateLabel: document.getElementById('laserStateLabel'),
    startTransmissionBtn: document.getElementById('startTransmissionBtn'),
    stopTransmissionBtn: document.getElementById('stopTransmissionBtn'),
    commandPendingMessage: document.getElementById('commandPendingMessage'),
    commandPendingText: document.getElementById('commandPendingText'),

    // System Status Card
    systemStatusCard: document.getElementById('systemStatusCard'),
    systemHealthBadge: document.getElementById('systemHealthBadge'),
    sysSerialLinkVal: document.getElementById('sysSerialLinkVal'),
    sysDataStreamVal: document.getElementById('sysDataStreamVal'),
    sysUpdateRateVal: document.getElementById('sysUpdateRateVal'),
    sysLastUpdateVal: document.getElementById('sysLastUpdateVal'),
    globalConditionText: document.getElementById('globalConditionText'),

    // Sensor Card 1: Laser Receiver (LDR)
    cardLaserReceiver: document.getElementById('cardLaserReceiver'),
    ldrStatusBadge: document.getElementById('ldrStatusBadge'),
    ldrDigitalVal: document.getElementById('ldrDigitalVal'),
    ldrSignalStateText: document.getElementById('ldrSignalStateText'),
    ldrAlarmStateText: document.getElementById('ldrAlarmStateText'),

    // Sensor Card 2: Ultrasonic Distance
    cardUltrasonic: document.getElementById('cardUltrasonic'),
    distanceStatusBadge: document.getElementById('distanceStatusBadge'),
    distanceVal: document.getElementById('distanceVal'),
    distanceUnitLabel: document.getElementById('distanceUnitLabel'),
    distanceEchoText: document.getElementById('distanceEchoText'),
    distanceZoneText: document.getElementById('distanceZoneText'),

    // Sensor Card 3: Vibration Monitoring
    cardVibration: document.getElementById('cardVibration'),
    vibrationStatusBadge: document.getElementById('vibrationStatusBadge'),
    vibrationDigitalVal: document.getElementById('vibrationDigitalVal'),
    vibrationStateText: document.getElementById('vibrationStateText'),
    vibrationAlarmText: document.getElementById('vibrationAlarmText'),

    // Sensor Card 4: Buzzer Alarm
    cardBuzzer: document.getElementById('cardBuzzer'),
    buzzerStatusBadge: document.getElementById('buzzerStatusBadge'),
    buzzerStateVal: document.getElementById('buzzerStateVal'),
    buzzerSourceText: document.getElementById('buzzerSourceText'),
    buzzerModeText: document.getElementById('buzzerModeText'),

    // Live Event Log
    eventCountBadge: document.getElementById('eventCountBadge'),
    clearLogBtn: document.getElementById('clearLogBtn'),
    logTableBody: document.getElementById('logTableBody'),
    emptyLogRow: document.getElementById('emptyLogRow'),

    // Troubleshooting Diagnostic Elements & Hardware Controls
    resetEspBtn: document.getElementById('resetEspBtn'),
    connectionTroubleshootBanner: document.getElementById('connectionTroubleshootBanner'),
    dismissTroubleshootBtn: document.getElementById('dismissTroubleshootBtn'),
    retryConnectBtn: document.getElementById('retryConnectBtn'),
    troubleshootErrorDetail: document.getElementById('troubleshootErrorDetail')
  };

  // --------------------------------------------------------------------------
  // Initialization & Event Listeners
  // --------------------------------------------------------------------------
  function init() {
    // 1. Check Web Serial API support
    if (!state.isSerialSupported) {
      if (dom.unsupportedBanner) dom.unsupportedBanner.classList.remove('hidden');
      if (dom.connectBtn) dom.connectBtn.disabled = true;
      setConnectionUI('ERROR', 'SERIAL UNSUPPORTED');
      addEvent('SYSTEM', 'Browser lacks Web Serial API support. Chromium desktop browser required.', 'danger');
      return;
    }

    // 2. Attach UI listeners
    dom.connectBtn.addEventListener('click', handleConnectClick);
    dom.disconnectBtn.addEventListener('click', handleDisconnectClick);
    dom.startTransmissionBtn.addEventListener('click', handleStartTransmissionClick);
    dom.stopTransmissionBtn.addEventListener('click', handleStopTransmissionClick);
    dom.clearLogBtn.addEventListener('click', clearLog);

    if (dom.dismissTroubleshootBtn) {
      dom.dismissTroubleshootBtn.addEventListener('click', () => {
        if (dom.connectionTroubleshootBanner) dom.connectionTroubleshootBanner.classList.add('hidden');
      });
    }

    if (dom.retryConnectBtn) {
      dom.retryConnectBtn.addEventListener('click', handleConnectClick);
    }

    if (dom.resetEspBtn) {
      dom.resetEspBtn.addEventListener('click', handleResetEspClick);
    }

    // 3. Listen for native USB port disconnect events
    navigator.serial.addEventListener('disconnect', (event) => {
      if (state.port && event.target === state.port) {
        addEvent('SERIAL', 'ESP32 device physically unplugged from USB port.', 'danger');
        handleUnexpectedDisconnect('DEVICE_UNPLUGGED');
      }
    });

    // 4. Start periodic stale data checking loop
    state.staleCheckTimerId = setInterval(checkStaleData, 500);

    // Initial log message
    addEvent('SYSTEM', 'AbyssLink dashboard initialized. Ready for USB connection.', 'info');
  }

  // --------------------------------------------------------------------------
  // USB Serial Connection Workflow
  // --------------------------------------------------------------------------
  async function handleConnectClick() {
    if (!state.isSerialSupported) return;

    // Hide any previous troubleshooting banner
    if (dom.connectionTroubleshootBanner) {
      dom.connectionTroubleshootBanner.classList.add('hidden');
    }

    try {
      setConnectionUI('CONNECTING', 'REQUESTING PORT...');
      addEvent('SERIAL', 'Requesting serial port selection from user.', 'info');

      // Request port from user gesture
      state.port = await navigator.serial.requestPort();

      setConnectionUI('CONNECTING', 'OPENING PORT (115200)...');
      await state.port.open({
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        bufferSize: 8192,
        flowControl: 'none'
      });

      // Clear DTR and RTS so ESP32 is released from bootloader / reset
      if (state.port.setSignals) {
        try {
          await state.port.setSignals({ dataTerminalReady: false, requestToSend: false });
        } catch (sigErr) {
          console.warn('Unable to set DTR/RTS signals:', sigErr);
        }
      }

      state.connectionState = 'CONNECTED';
      state.keepReading = true;
      state.lastPacketTimestamp = Date.now();
      state.isDataStale = false;

      setConnectionUI('CONNECTED', 'CONNECTED');
      dom.connectBtn.disabled = true;
      dom.disconnectBtn.disabled = false;
      if (dom.resetEspBtn) dom.resetEspBtn.disabled = false;
      dom.startTransmissionBtn.disabled = false;
      dom.stopTransmissionBtn.disabled = true;

      dom.sysSerialLinkVal.textContent = '115200 Baud (Active)';
      dom.sysDataStreamVal.textContent = 'Listening...';
      dom.globalConditionText.textContent = 'Connected to ESP32. Ready to begin laser transmission.';

      addEvent('SERIAL', 'ESP32 connected successfully at 115200 baud.', 'safe');

      // Launch continuous read loop
      readSerialLoop();

    } catch (err) {
      if (err.name === 'NotFoundError') {
        // User cancelled port selection dialog
        setConnectionUI('DISCONNECTED', 'DISCONNECTED');
        dom.connectBtn.disabled = false;
        dom.disconnectBtn.disabled = true;
        if (dom.resetEspBtn) dom.resetEspBtn.disabled = true;
        addEvent('SERIAL', 'Port selection cancelled by user.', 'info');
      } else {
        console.error('Serial connection error:', err);
        setConnectionUI('ERROR', 'CONNECTION FAILED');
        dom.connectBtn.disabled = false;
        dom.disconnectBtn.disabled = true;
        if (dom.resetEspBtn) dom.resetEspBtn.disabled = true;

        showTroubleshootBanner(err);
        addEvent('SERIAL', `Failed to open serial port: ${err.message}`, 'danger');

        state.port = null;
      }
    }
  }

  function showTroubleshootBanner(err) {
    if (!dom.connectionTroubleshootBanner) return;
    const msg = (err && err.message) ? err.message : 'Unknown error';
    let detailText = `The browser could not open the selected serial port (${msg}).`;

    if (msg.toLowerCase().includes('failed to open') || err.name === 'NetworkError') {
      detailText = `Port Access Denied: The COM port is locked by another program (most commonly the Arduino IDE Serial Monitor or Plotter). Please close the Arduino IDE Serial Monitor completely, then click "Try Connecting Again".`;
    } else if (err.name === 'InvalidStateError') {
      detailText = `The serial port is already open or busy. Refresh the page or disconnect any other session before connecting.`;
    }

    if (dom.troubleshootErrorDetail) {
      dom.troubleshootErrorDetail.textContent = detailText;
    }
    dom.connectionTroubleshootBanner.classList.remove('hidden');
  }

  async function handleResetEspClick() {
    if (!state.port) return;
    try {
      addEvent('SYSTEM', 'Sending reboot pulse (RTS) to ESP32...', 'warning');
      if (state.port.setSignals) {
        await state.port.setSignals({ dataTerminalReady: false, requestToSend: true });
        await new Promise(r => setTimeout(r, 120));
        await state.port.setSignals({ dataTerminalReady: false, requestToSend: false });
        addEvent('SYSTEM', 'ESP32 hardware rebooted via RTS signal.', 'safe');
      } else {
        addEvent('SERIAL', 'Hardware signal control not supported by this USB driver.', 'warning');
      }
    } catch (e) {
      console.warn('Could not reset ESP32 via RTS:', e);
      addEvent('SERIAL', `Reset signal failed: ${e.message}`, 'warning');
    }
  }

  async function handleDisconnectClick() {
    if (!state.port) return;

    addEvent('SERIAL', 'Disconnect initiated by user.', 'info');
    await closeConnectionCleanly();
  }

  async function handleUnexpectedDisconnect(reason) {
    await closeConnectionCleanly();
    setConnectionUI('ERROR', reason === 'DEVICE_UNPLUGGED' ? 'DEVICE UNPLUGGED' : 'CONNECTION LOST');
  }

  async function closeConnectionCleanly() {
    state.keepReading = false;

    // Release reader lock
    if (state.reader) {
      try {
        await state.reader.cancel();
      } catch (e) {
        // Ignore cancel errors on teardown
      }
      try {
        state.reader.releaseLock();
      } catch (e) {
        // Ignore lock release error
      }
      state.reader = null;
    }

    // Release writer lock
    if (state.writer) {
      try {
        state.writer.releaseLock();
      } catch (e) {
        // Ignore
      }
      state.writer = null;
    }

    // Close physical port
    if (state.port) {
      try {
        await state.port.close();
      } catch (e) {
        console.warn('Error closing serial port:', e);
      }
      state.port = null;
    }

    // Reset application state
    state.connectionState = 'DISCONNECTED';
    state.isTransmissionActive = false;
    state.isCommandPending = false;
    if (state.commandPendingTimeoutId) {
      clearTimeout(state.commandPendingTimeoutId);
      state.commandPendingTimeoutId = null;
    }

    resetDashboardToNeutral();
    setConnectionUI('DISCONNECTED', 'DISCONNECTED');
    dom.connectBtn.disabled = false;
    dom.disconnectBtn.disabled = true;
    if (dom.resetEspBtn) dom.resetEspBtn.disabled = true;
    dom.startTransmissionBtn.disabled = true;
    dom.stopTransmissionBtn.disabled = true;

    addEvent('SERIAL', 'ESP32 disconnected and serial resources released.', 'info');
  }

  // --------------------------------------------------------------------------
  // Serial Read Loop with Stream Buffering & Chunk Parsing
  // --------------------------------------------------------------------------
  async function readSerialLoop() {
    let textBuffer = '';
    const textDecoder = new TextDecoder();

    while (state.port && state.port.readable && state.keepReading) {
      try {
        state.reader = state.port.readable.getReader();

        while (state.keepReading) {
          const { value, done } = await state.reader.read();
          if (done) {
            // Stream was cancelled or closed
            break;
          }

          if (value) {
            // Decode incoming binary chunk into text
            const chunk = textDecoder.decode(value, { stream: true });
            textBuffer += chunk;

            // Process all newline-terminated lines
            let newlineIdx;
            while ((newlineIdx = textBuffer.indexOf('\n')) >= 0) {
              const rawLine = textBuffer.slice(0, newlineIdx).trim();
              textBuffer = textBuffer.slice(newlineIdx + 1);

              if (rawLine.length > 0) {
                processIncomingLine(rawLine);
              }
            }
          }
        }
      } catch (err) {
        if (state.keepReading) {
          console.error('Serial read loop error:', err);
          addEvent('SERIAL', `Serial read error: ${err.message}`, 'danger');
          handleUnexpectedDisconnect('STREAM_ERROR');
        }
        break;
      } finally {
        if (state.reader) {
          try {
            state.reader.releaseLock();
          } catch (e) {
            // Ignore
          }
          state.reader = null;
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Parse and Route Incoming Newline-Delimited JSON Messages
  // --------------------------------------------------------------------------
  function processIncomingLine(line) {
    const rawClean = line.replace(/[\r\n]/g, '').trim();
    if (rawClean.length === 0) return;

    // Any non-empty line received proves the serial physical link is receiving bytes
    state.lastPacketTimestamp = Date.now();
    if (state.isDataStale) {
      state.isDataStale = false;
      addEvent('SYSTEM', 'Sensor data stream restored.', 'safe');
    }

    let packet;
    try {
      packet = JSON.parse(rawClean);
    } catch (err) {
      // Non-JSON line: captures ESP32 boot messages or raw prints in the event log
      addEvent('RAW SERIAL', rawClean.slice(0, 80), 'info');
      return;
    }

    if (!packet || typeof packet !== 'object') return;

    if (packet.type === 'sensor') {
      handleSensorTelemetry(packet);
    } else if (packet.type === 'ack') {
      handleCommandAcknowledgement(packet);
    }
  }

  // --------------------------------------------------------------------------
  // Telemetry Processing & Dashboard Updates
  // --------------------------------------------------------------------------
  function handleSensorTelemetry(data) {
    const prev = state.lastTelemetry;

    // Detect State Transitions for Event Log
    detectStateTransitions(prev, data);

    // Update internal reference
    state.lastTelemetry = Object.assign({}, data);
    state.isTransmissionActive = Boolean(data.transmission);

    // Update Timestamps & Telemetry Indicators
    const nowStr = formatTimestamp(new Date());
    dom.sysLastUpdateVal.textContent = nowStr;
    dom.sysDataStreamVal.textContent = 'Active (Live)';

    // Update Card: Laser Transmission Control
    updateTransmissionCard(data);

    // Update Card 1: Optical Receiver (LDR)
    updateOpticalReceiverCard(data);

    // Update Card 2: Ultrasonic Distance
    updateUltrasonicCard(data);

    // Update Card 3: Vibration Monitoring
    updateVibrationCard(data);

    // Update Card 4: Buzzer Alarm
    updateBuzzerCard(data);

    // Update Global Health Badge and System Summary
    updateGlobalSystemSummary(data);
  }

  function detectStateTransitions(prev, curr) {
    // 1. Transmission status change
    if (prev.transmission !== null && prev.transmission !== curr.transmission) {
      if (curr.transmission) {
        addEvent('OPTICAL', 'Laser transmission started by ESP32.', 'safe');
      } else {
        addEvent('OPTICAL', 'Laser transmission stopped by ESP32.', 'info');
      }
    }

    // 2. Optical LDR signal interruption during active transmission
    if (curr.transmission) {
      if (prev.ldr !== null && prev.ldr !== curr.ldr) {
        if (curr.ldr === 1) {
          addEvent('OPTICAL', 'Laser signal broken! Optical path interrupted.', 'danger');
        } else if (curr.ldr === 0) {
          addEvent('OPTICAL', 'Laser signal restored to receiver.', 'safe');
        }
      }
    }

    // 3. Vibration detection transition
    if (prev.vibration !== null && prev.vibration !== curr.vibration) {
      if (curr.vibration === 1) {
        addEvent('SEISMIC', 'Vibration detected by seismic sensor!', 'danger');
      } else if (curr.vibration === 0) {
        addEvent('SEISMIC', 'Vibration cleared. Sensor returned to normal.', 'safe');
      }
    }

    // 4. Ultrasonic Proximity Zone transition
    if (prev.alert !== curr.alert) {
      if (curr.alert === 'CRITICAL_PROXIMITY') {
        addEvent('RADAR', `Object within critical proximity: ${curr.distance_cm} cm!`, 'danger');
      } else if (curr.alert === 'PROXIMITY_DANGER') {
        addEvent('RADAR', `Proximity danger detected: ${curr.distance_cm} cm.`, 'danger');
      } else if (curr.alert === 'PROXIMITY_WARNING') {
        addEvent('RADAR', `Proximity warning threshold reached: ${curr.distance_cm} cm.`, 'warning');
      } else if (curr.alert === 'SAFE' && (prev.alert === 'CRITICAL_PROXIMITY' || prev.alert === 'PROXIMITY_DANGER' || prev.alert === 'PROXIMITY_WARNING')) {
        addEvent('RADAR', 'Object moved outside warning range. Proximity safe.', 'safe');
      }
    }

    // 5. Buzzer state transition
    if (prev.buzzer !== null && prev.buzzer !== curr.buzzer) {
      if (curr.buzzer === 'ON') {
        addEvent('ACOUSTIC', `Hardware alarm buzzer triggered (${curr.alert}).`, 'danger');
      } else if (curr.buzzer === 'OFF') {
        addEvent('ACOUSTIC', 'Hardware alarm buzzer silenced.', 'safe');
      }
    }
  }

  // --------------------------------------------------------------------------
  // Specific Component Renderers
  // --------------------------------------------------------------------------
  function updateTransmissionCard(data) {
    const isActive = Boolean(data.transmission);

    if (isActive) {
      dom.transmissionBadge.textContent = 'TRANSMISSION ACTIVE';
      dom.transmissionBadge.className = 'badge badge-safe';
      dom.transmissionStatusVal.textContent = 'TRANSMISSION ACTIVE';

      dom.laserDot.className = 'indicator-dot-sm on';
      dom.laserStateLabel.textContent = 'ON';

      if (!state.isCommandPending) {
        dom.startTransmissionBtn.disabled = true;
        dom.stopTransmissionBtn.disabled = false;
      }
    } else {
      dom.transmissionBadge.textContent = 'TRANSMISSION STOPPED';
      dom.transmissionBadge.className = 'badge badge-neutral';
      dom.transmissionStatusVal.textContent = 'TRANSMISSION STOPPED';

      dom.laserDot.className = 'indicator-dot-sm off';
      dom.laserStateLabel.textContent = 'OFF';

      if (!state.isCommandPending) {
        dom.startTransmissionBtn.disabled = false;
        dom.stopTransmissionBtn.disabled = true;
      }
    }
  }

  function updateOpticalReceiverCard(data) {
    const isActive = Boolean(data.transmission);
    const ldrVal = Number(data.ldr);

    dom.ldrDigitalVal.textContent = isNaN(ldrVal) ? '--' : ldrVal;

    // Reset card highlight classes
    dom.cardLaserReceiver.classList.remove('highlight-warning', 'highlight-danger');

    if (!isActive) {
      // Transmission intentionally stopped: not an error
      dom.ldrStatusBadge.textContent = 'TRANSMISSION INACTIVE';
      dom.ldrStatusBadge.className = 'badge badge-neutral';
      dom.ldrSignalStateText.textContent = 'TRANSMISSION INACTIVE';
      dom.ldrAlarmStateText.textContent = 'Disarmed (Laser Off)';
    } else {
      // Transmission is active
      if (ldrVal === 0) {
        // Laser light reaches LDR: Normal
        dom.ldrStatusBadge.textContent = 'SIGNAL RECEIVED';
        dom.ldrStatusBadge.className = 'badge badge-safe';
        dom.ldrSignalStateText.textContent = 'SIGNAL RECEIVED';
        dom.ldrAlarmStateText.textContent = 'Normal (No Alarm)';
      } else {
        // Laser light interrupted: Danger!
        dom.ldrStatusBadge.textContent = 'SIGNAL INTERRUPTED';
        dom.ldrStatusBadge.className = 'badge badge-danger';
        dom.ldrSignalStateText.textContent = 'SIGNAL INTERRUPTED';
        dom.ldrAlarmStateText.textContent = 'Continuous Alarm Active';
        dom.cardLaserReceiver.classList.add('highlight-danger');
      }
    }
  }

  function updateUltrasonicCard(data) {
    const isValid = Boolean(data.distance_valid) && data.distance_cm !== null;
    const dist = isValid ? Number(data.distance_cm) : null;

    dom.cardUltrasonic.classList.remove('highlight-warning', 'highlight-danger');

    if (!isValid || dist === null) {
      dom.distanceVal.textContent = 'NO ECHO';
      dom.distanceUnitLabel.textContent = '';
      dom.distanceStatusBadge.textContent = 'UNAVAILABLE';
      dom.distanceStatusBadge.className = 'badge badge-neutral';
      dom.distanceEchoText.textContent = 'No Return Pulse';
      dom.distanceZoneText.textContent = 'Measurement Unavailable';
    } else {
      dom.distanceVal.textContent = dist.toFixed(1);
      dom.distanceUnitLabel.textContent = 'cm';
      dom.distanceEchoText.textContent = 'Valid Echo Return';

      if (dist <= 5.0) {
        dom.distanceStatusBadge.textContent = 'CRITICAL';
        dom.distanceStatusBadge.className = 'badge badge-danger';
        dom.distanceZoneText.textContent = 'Critical (<= 5 cm)';
        dom.cardUltrasonic.classList.add('highlight-danger');
      } else if (dist <= 50.0) {
        dom.distanceStatusBadge.textContent = 'DANGER';
        dom.distanceStatusBadge.className = 'badge badge-danger';
        dom.distanceZoneText.textContent = 'Danger Zone (6-50 cm)';
        dom.cardUltrasonic.classList.add('highlight-danger');
      } else if (dist <= 80.0) {
        dom.distanceStatusBadge.textContent = 'WARNING';
        dom.distanceStatusBadge.className = 'badge badge-warning';
        dom.distanceZoneText.textContent = 'Warning Zone (51-80 cm)';
        dom.cardUltrasonic.classList.add('highlight-warning');
      } else {
        dom.distanceStatusBadge.textContent = 'SAFE';
        dom.distanceStatusBadge.className = 'badge badge-safe';
        dom.distanceZoneText.textContent = 'Safe Zone (> 80 cm)';
      }
    }
  }

  function updateVibrationCard(data) {
    const vib = Number(data.vibration);
    dom.vibrationDigitalVal.textContent = isNaN(vib) ? '--' : vib;

    dom.cardVibration.classList.remove('highlight-danger');

    if (vib === 1) {
      dom.vibrationStatusBadge.textContent = 'VIBRATION DETECTED';
      dom.vibrationStatusBadge.className = 'badge badge-danger';
      dom.vibrationStateText.textContent = 'VIBRATION DETECTED';
      dom.vibrationAlarmText.textContent = 'Continuous Alarm Active';
      dom.cardVibration.classList.add('highlight-danger');
    } else {
      dom.vibrationStatusBadge.textContent = 'NORMAL';
      dom.vibrationStatusBadge.className = 'badge badge-safe';
      dom.vibrationStateText.textContent = 'NORMAL';
      dom.vibrationAlarmText.textContent = 'Inactive (Normal)';
    }
  }

  function updateBuzzerCard(data) {
    const isBuzzerOn = data.buzzer === 'ON';
    const alert = data.alert || 'SAFE';

    dom.cardBuzzer.classList.remove('highlight-danger', 'highlight-warning');

    if (isBuzzerOn) {
      dom.buzzerStatusBadge.textContent = 'ACTIVE';
      dom.buzzerStatusBadge.className = 'badge badge-danger';
      dom.buzzerStateVal.textContent = 'ACTIVE';
      dom.cardBuzzer.classList.add('highlight-danger');
    } else {
      dom.buzzerStatusBadge.textContent = 'OFF';
      dom.buzzerStatusBadge.className = 'badge badge-neutral';
      dom.buzzerStateVal.textContent = 'OFF';
    }

    // Determine Alarm Source & Cadence from protocol alert
    let sourceText = 'No active alert';
    let cadenceText = 'Silent';

    switch (alert) {
      case 'LASER_INTERRUPTION':
        sourceText = 'Laser interruption';
        cadenceText = 'Continuous Alarm';
        break;
      case 'VIBRATION':
        sourceText = 'Vibration event';
        cadenceText = 'Continuous Alarm';
        break;
      case 'CRITICAL_PROXIMITY':
        sourceText = 'Critical distance (<= 5cm)';
        cadenceText = 'Continuous Alarm';
        break;
      case 'PROXIMITY_DANGER':
        sourceText = 'Proximity danger (6-50cm)';
        cadenceText = 'Fast Intermittent Beep';
        break;
      case 'PROXIMITY_WARNING':
        sourceText = 'Proximity warning (51-80cm)';
        cadenceText = 'Slow Intermittent Beep';
        break;
      case 'DISTANCE_UNAVAILABLE':
        sourceText = 'Distance sensor unavailable';
        cadenceText = 'Silent';
        break;
      case 'SAFE':
      default:
        sourceText = 'No active alert';
        cadenceText = 'Silent';
        break;
    }

    dom.buzzerSourceText.textContent = sourceText;
    dom.buzzerModeText.textContent = cadenceText;
  }

  function updateGlobalSystemSummary(data) {
    const alert = data.alert || 'SAFE';

    if (alert === 'LASER_INTERRUPTION') {
      dom.systemHealthBadge.textContent = 'CRITICAL ALERT';
      dom.systemHealthBadge.className = 'badge badge-danger';
      dom.globalConditionText.textContent = 'CRITICAL: Optical laser transmission interrupted during active session.';
    } else if (alert === 'VIBRATION') {
      dom.systemHealthBadge.textContent = 'CRITICAL ALERT';
      dom.systemHealthBadge.className = 'badge badge-danger';
      dom.globalConditionText.textContent = 'CRITICAL: Cable vibration anomaly detected. Continuous alert activated.';
    } else if (alert === 'CRITICAL_PROXIMITY') {
      dom.systemHealthBadge.textContent = 'CRITICAL ALERT';
      dom.systemHealthBadge.className = 'badge badge-danger';
      dom.globalConditionText.textContent = 'CRITICAL: Proximity intrusion at or below 5 cm!';
    } else if (alert === 'PROXIMITY_DANGER') {
      dom.systemHealthBadge.textContent = 'WARNING';
      dom.systemHealthBadge.className = 'badge badge-danger';
      dom.globalConditionText.textContent = 'DANGER: Approaching underwater obstacle in danger zone (6-50 cm).';
    } else if (alert === 'PROXIMITY_WARNING') {
      dom.systemHealthBadge.textContent = 'WARNING';
      dom.systemHealthBadge.className = 'badge badge-warning';
      dom.globalConditionText.textContent = 'WARNING: Obstacle detected within warning zone (51-80 cm).';
    } else {
      if (data.transmission) {
        dom.systemHealthBadge.textContent = 'TRANSMISSION ACTIVE';
        dom.systemHealthBadge.className = 'badge badge-safe';
        dom.globalConditionText.textContent = 'Normal operations. Optical transmission verified and sensors nominal.';
      } else {
        dom.systemHealthBadge.textContent = 'CONNECTED';
        dom.systemHealthBadge.className = 'badge badge-neutral';
        dom.globalConditionText.textContent = 'Connected. Transmission channel idle. Sensors continuously monitoring.';
      }
    }
  }

  // --------------------------------------------------------------------------
  // Command Transmission & Acknowledgement Handling
  // --------------------------------------------------------------------------
  async function handleStartTransmissionClick() {
    if (!state.port || state.isCommandPending) return;
    await sendSerialCommand('START_TRANSMISSION');
  }

  async function handleStopTransmissionClick() {
    if (!state.port || state.isCommandPending) return;
    await sendSerialCommand('STOP_TRANSMISSION');
  }

  async function sendSerialCommand(commandName) {
    if (!state.port || !state.port.writable) {
      addEvent('SERIAL', `Cannot send ${commandName}: Serial port not writable.`, 'danger');
      return;
    }

    state.isCommandPending = true;
    dom.startTransmissionBtn.disabled = true;
    dom.stopTransmissionBtn.disabled = true;
    dom.commandPendingText.textContent = `Sending ${commandName}...`;
    dom.commandPendingMessage.classList.remove('hidden');

    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(commandName + '\n');

      state.writer = state.port.writable.getWriter();
      await state.writer.write(data);
      state.writer.releaseLock();
      state.writer = null;

      addEvent('SYSTEM', `Command transmitted: ${commandName}`, 'info');

      // Safety timeout: 3 seconds to receive ACK
      state.commandPendingTimeoutId = setTimeout(() => {
        if (state.isCommandPending) {
          state.isCommandPending = false;
          dom.commandPendingMessage.classList.add('hidden');
          addEvent('SERIAL', `Command ${commandName} timed out awaiting ACK.`, 'warning');
          // Re-evaluate button states based on last known state
          dom.startTransmissionBtn.disabled = state.isTransmissionActive;
          dom.stopTransmissionBtn.disabled = !state.isTransmissionActive;
        }
      }, 3000);

    } catch (err) {
      console.error('Error writing to serial port:', err);
      if (state.writer) {
        try { state.writer.releaseLock(); } catch (e) {}
        state.writer = null;
      }
      state.isCommandPending = false;
      dom.commandPendingMessage.classList.add('hidden');
      addEvent('SERIAL', `Failed to transmit command: ${err.message}`, 'danger');
    }
  }

  function handleCommandAcknowledgement(ack) {
    if (state.commandPendingTimeoutId) {
      clearTimeout(state.commandPendingTimeoutId);
      state.commandPendingTimeoutId = null;
    }

    state.isCommandPending = false;
    dom.commandPendingMessage.classList.add('hidden');

    if (ack.success) {
      state.isTransmissionActive = Boolean(ack.transmission);
      dom.startTransmissionBtn.disabled = state.isTransmissionActive;
      dom.stopTransmissionBtn.disabled = !state.isTransmissionActive;

      if (ack.command === 'START_TRANSMISSION') {
        addEvent('SYSTEM', 'ESP32 confirmed: Transmission active.', 'safe');
      } else if (ack.command === 'STOP_TRANSMISSION') {
        addEvent('SYSTEM', 'ESP32 confirmed: Transmission stopped.', 'info');
      }
    } else {
      addEvent('SERIAL', `ESP32 rejected command: ${ack.command}`, 'warning');
      dom.startTransmissionBtn.disabled = state.isTransmissionActive;
      dom.stopTransmissionBtn.disabled = !state.isTransmissionActive;
    }
  }

  // --------------------------------------------------------------------------
  // Stale Data Detection Loop
  // --------------------------------------------------------------------------
  function checkStaleData() {
    if (state.connectionState !== 'CONNECTED' || !state.lastPacketTimestamp) {
      return;
    }

    const elapsed = Date.now() - state.lastPacketTimestamp;

    if (elapsed > STALE_DATA_TIMEOUT_MS) {
      if (!state.isDataStale) {
        state.isDataStale = true;
        dom.sysDataStreamVal.textContent = 'DATA STALE';
        dom.systemHealthBadge.textContent = 'DATA STALE';
        dom.systemHealthBadge.className = 'badge badge-warning';
        dom.globalConditionText.textContent = 'WARNING: No telemetry packets received for over 2 seconds.';
        addEvent('SYSTEM', 'Sensor data became stale (> 2s without packet).', 'warning');
      }
    }
  }

  // --------------------------------------------------------------------------
  // UI Helpers & State Reset
  // --------------------------------------------------------------------------
  function setConnectionUI(status, label) {
    state.connectionState = status;
    dom.connectionStatusLabel.textContent = label;

    dom.connectionIndicatorDot.className = 'status-indicator-dot';
    switch (status) {
      case 'CONNECTED':
        dom.connectionIndicatorDot.classList.add('connected');
        break;
      case 'CONNECTING':
        dom.connectionIndicatorDot.classList.add('connecting');
        break;
      case 'ERROR':
        dom.connectionIndicatorDot.classList.add('error');
        break;
      case 'DISCONNECTED':
      default:
        dom.connectionIndicatorDot.classList.add('disconnected');
        break;
    }
  }

  function resetDashboardToNeutral() {
    // Control Card
    dom.transmissionBadge.textContent = 'INACTIVE';
    dom.transmissionBadge.className = 'badge badge-neutral';
    dom.transmissionStatusVal.textContent = 'DISCONNECTED';
    dom.laserDot.className = 'indicator-dot-sm off';
    dom.laserStateLabel.textContent = 'OFF';
    dom.commandPendingMessage.classList.add('hidden');

    // System Status Card
    dom.systemHealthBadge.textContent = 'DISCONNECTED';
    dom.systemHealthBadge.className = 'badge badge-neutral';
    dom.sysSerialLinkVal.textContent = 'Disconnected';
    dom.sysDataStreamVal.textContent = 'Idle';
    dom.sysLastUpdateVal.textContent = '--:--:--';
    dom.globalConditionText.textContent = 'System awaiting hardware connection via USB serial port.';

    // Sensor Card 1: LDR
    dom.cardLaserReceiver.classList.remove('highlight-warning', 'highlight-danger');
    dom.ldrStatusBadge.textContent = 'INACTIVE';
    dom.ldrStatusBadge.className = 'badge badge-neutral';
    dom.ldrDigitalVal.textContent = '--';
    dom.ldrSignalStateText.textContent = 'TRANSMISSION INACTIVE';
    dom.ldrAlarmStateText.textContent = 'Disarmed (Laser Off)';

    // Sensor Card 2: Ultrasonic
    dom.cardUltrasonic.classList.remove('highlight-warning', 'highlight-danger');
    dom.distanceStatusBadge.textContent = '--';
    dom.distanceStatusBadge.className = 'badge badge-neutral';
    dom.distanceVal.textContent = '--';
    dom.distanceUnitLabel.textContent = 'cm';
    dom.distanceEchoText.textContent = 'Unavailable';
    dom.distanceZoneText.textContent = '--';

    // Sensor Card 3: Vibration
    dom.cardVibration.classList.remove('highlight-danger');
    dom.vibrationStatusBadge.textContent = '--';
    dom.vibrationStatusBadge.className = 'badge badge-neutral';
    dom.vibrationDigitalVal.textContent = '--';
    dom.vibrationStateText.textContent = 'NORMAL';
    dom.vibrationAlarmText.textContent = 'Inactive';

    // Sensor Card 4: Buzzer
    dom.cardBuzzer.classList.remove('highlight-danger');
    dom.buzzerStatusBadge.textContent = 'OFF';
    dom.buzzerStatusBadge.className = 'badge badge-neutral';
    dom.buzzerStateVal.textContent = 'OFF';
    dom.buzzerSourceText.textContent = 'No active alert';
    dom.buzzerModeText.textContent = 'Silent';

    // Last telemetry tracking reset
    state.lastTelemetry = {
      transmission: null,
      ldr: null,
      vibration: null,
      distance_cm: null,
      distance_valid: null,
      laser: null,
      buzzer: null,
      alert: null
    };
  }

  // --------------------------------------------------------------------------
  // Live Event Log System
  // --------------------------------------------------------------------------
  function addEvent(category, description, impact) {
    const timestamp = formatTimestamp(new Date(), true);
    const eventItem = { timestamp, category, description, impact };

    state.events.unshift(eventItem);
    if (state.events.length > MAX_EVENTS) {
      state.events.pop();
    }

    renderEventLog();
  }

  function renderEventLog() {
    dom.eventCountBadge.textContent = `${state.events.length} event${state.events.length === 1 ? '' : 's'}`;

    if (state.events.length === 0) {
      dom.logTableBody.innerHTML = `
        <tr class="log-empty-row" id="emptyLogRow">
          <td colspan="4">No hardware events logged yet. Connect ESP32 device to begin monitoring.</td>
        </tr>
      `;
      return;
    }

    const rowsHtml = state.events.map(evt => {
      const tagClass = getTagClass(evt.impact);
      const impactLabel = formatImpactLabel(evt.impact);
      return `
        <tr>
          <td class="log-timestamp">${evt.timestamp}</td>
          <td><span class="log-tag ${tagClass}">${escapeHtml(evt.category)}</span></td>
          <td>${escapeHtml(evt.description)}</td>
          <td class="log-impact">${impactLabel}</td>
        </tr>
      `;
    }).join('');

    dom.logTableBody.innerHTML = rowsHtml;
  }

  function clearLog() {
    state.events = [];
    renderEventLog();
  }

  function getTagClass(impact) {
    switch (impact) {
      case 'danger': return 'danger';
      case 'warning': return 'warning';
      case 'safe': return 'safe';
      case 'info':
      default: return 'info';
    }
  }

  function formatImpactLabel(impact) {
    switch (impact) {
      case 'danger': return '<span style="color: var(--status-danger-text); font-weight: 600;">Critical</span>';
      case 'warning': return '<span style="color: var(--status-warning-text); font-weight: 600;">Warning</span>';
      case 'safe': return '<span style="color: var(--status-safe-text); font-weight: 600;">Normal</span>';
      case 'info':
      default: return '<span style="color: var(--text-muted);">Informational</span>';
    }
  }

  // --------------------------------------------------------------------------
  // String & Time Utilities
  // --------------------------------------------------------------------------
  function formatTimestamp(date, withMs = false) {
    const pad = (n) => String(n).padStart(2, '0');
    const h = pad(date.getHours());
    const m = pad(date.getMinutes());
    const s = pad(date.getSeconds());
    if (withMs) {
      const ms = String(date.getMilliseconds()).padStart(3, '0');
      return `${h}:${m}:${s}.${ms}`;
    }
    return `${h}:${m}:${s}`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Run on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

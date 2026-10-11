/*
 * ============================================================================
 * AbyssLink - Smart Submarine Cable Protection & Laser Data Transmission
 * ESP32 Firmware (AbyssLink_ESP32.ino)
 * ============================================================================
 * 
 * Hardware Pin Configuration:
 *   - Laser Transmitter:               GPIO 25 (OUTPUT)
 *   - Ultrasonic Sensor TRIG:          GPIO 5  (OUTPUT)
 *   - Ultrasonic Sensor ECHO:          GPIO 18 (INPUT)
 *   - LDR Digital Output:              GPIO 34 (INPUT, Note: Input-only, no pull-up/down)
 *   - Vibration Sensor Digital Output: GPIO 27 (INPUT)
 *   - Buzzer Signal:                   GPIO 26 (OUTPUT)
 *
 * Serial Communication:
 *   - Baud Rate: 115200
 *   - Protocol: Newline-delimited JSON telemetry updates and acknowledgements.
 *   - Commands: START_TRANSMISSION\n, STOP_TRANSMISSION\n
 * ============================================================================
 */

#include <Arduino.h>

// ----------------------------------------------------------------------------
// Pin Definitions
// ----------------------------------------------------------------------------
const int PIN_LASER     = 25;
const int PIN_TRIG      = 5;
const int PIN_ECHO      = 18;
const int PIN_LDR       = 34; // Input-only pin, ensure module provides valid digital signal
const int PIN_VIBRATION = 27;
const int PIN_BUZZER    = 26;

// ----------------------------------------------------------------------------
// Thresholds & Constants
// ----------------------------------------------------------------------------
const float DISTANCE_CRITICAL_CM = 5.0f;
const float DISTANCE_DANGER_CM   = 50.0f;
const float DISTANCE_WARNING_CM  = 80.0f;

// Ultrasonic pulse timeout: 30,000 microseconds (~500 cm max range)
const unsigned long ULTRASONIC_TIMEOUT_US = 30000UL;

// Telemetry transmit interval: 300 ms (meets 250 - 500 ms requirement)
const unsigned long TELEMETRY_INTERVAL_MS = 300UL;

// Ultrasonic measurement interval: 80 ms (avoids acoustic overlap)
const unsigned long ULTRASONIC_INTERVAL_MS = 80UL;

// ----------------------------------------------------------------------------
// State Variables
// ----------------------------------------------------------------------------
bool isTransmissionActive = false; // Laser data transmission state
bool laserPinState        = false;
bool buzzerPhysicalState  = false;

// Sensor readings
int ldrReading            = 1;     // 0 = Light detected (normal), 1 = Interrupted
int vibrationReading      = 0;     // 0 = Normal, 1 = Vibration detected
float currentDistanceCm   = -1.0f;
bool isDistanceValid      = false;

// Active alert status string
enum AlertSource {
  ALERT_SAFE,
  ALERT_LASER_INTERRUPTION,
  ALERT_VIBRATION,
  ALERT_CRITICAL_PROXIMITY,
  ALERT_PROXIMITY_DANGER,
  ALERT_PROXIMITY_WARNING,
  ALERT_DISTANCE_UNAVAILABLE
};

AlertSource currentAlert = ALERT_SAFE;

// Non-blocking timing markers
unsigned long lastTelemetryTime   = 0;
unsigned long lastUltrasonicTime  = 0;
unsigned long lastBuzzerToggleTime = 0;
bool buzzerBeepPhase              = false;

// Serial input buffer
const size_t SERIAL_BUF_SIZE = 128;
char serialCommandBuffer[SERIAL_BUF_SIZE];
size_t serialCommandIndex = 0;

// ----------------------------------------------------------------------------
// Function Declarations
// ----------------------------------------------------------------------------
void measureDistance();
void updateSensorLogic();
void updateBuzzerState();
void sendTelemetry();
void handleSerialCommands();
void executeCommand(const char* command);
void sendAck(const char* cmd, bool success, bool transmissionState);

// ----------------------------------------------------------------------------
// Arduino Setup
// ----------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);

  // Configure GPIO directions
  pinMode(PIN_LASER, OUTPUT);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_LDR, INPUT);          // GPIO 34 is input-only
  pinMode(PIN_VIBRATION, INPUT);
  pinMode(PIN_BUZZER, OUTPUT);

  // Initial safe hardware state
  digitalWrite(PIN_LASER, LOW);
  digitalWrite(PIN_TRIG, LOW);
  digitalWrite(PIN_BUZZER, LOW);

  isTransmissionActive = false;
  laserPinState = false;
  buzzerPhysicalState = false;
}

// ----------------------------------------------------------------------------
// Arduino Main Loop
// ----------------------------------------------------------------------------
void loop() {
  unsigned long now = millis();

  // 1. Process incoming serial commands from browser dashboard
  handleSerialCommands();

  // 2. Perform periodic non-blocking ultrasonic distance measurement
  if (now - lastUltrasonicTime >= ULTRASONIC_INTERVAL_MS) {
    lastUltrasonicTime = now;
    measureDistance();
  }

  // 3. Read other sensors & determine system alert priority
  updateSensorLogic();

  // 4. Drive buzzer based on alert priority using non-blocking state machine
  updateBuzzerState();

  // 5. Broadcast newline-delimited JSON telemetry to the serial port
  if (now - lastTelemetryTime >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryTime = now;
    sendTelemetry();
  }
}

// ----------------------------------------------------------------------------
// Ultrasonic Distance Measurement
// ----------------------------------------------------------------------------
void measureDistance() {
  // Trigger a 10us pulse on TRIG pin
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);

  // Measure echo pulse width (capped at 30ms to prevent loop blocking)
  unsigned long duration = pulseIn(PIN_ECHO, HIGH, ULTRASONIC_TIMEOUT_US);

  if (duration == 0) {
    // No echo received within timeout or out of range
    isDistanceValid = false;
    currentDistanceCm = -1.0f;
  } else {
    // Sound speed in air: ~0.0343 cm/us -> distance = (duration * 0.0343) / 2
    float dist = (float)duration * 0.0343f / 2.0f;
    // Check reasonable physical limits (2 cm to 450 cm)
    if (dist >= 2.0f && dist <= 450.0f) {
      currentDistanceCm = dist;
      isDistanceValid = true;
    } else {
      isDistanceValid = false;
      currentDistanceCm = -1.0f;
    }
  }
}

// ----------------------------------------------------------------------------
// Sensor Logic & Priority Evaluation
// ----------------------------------------------------------------------------
void updateSensorLogic() {
  // Read digital sensors
  ldrReading = digitalRead(PIN_LDR);
  vibrationReading = digitalRead(PIN_VIBRATION);

  // Evaluate Laser Transmission State
  if (isTransmissionActive) {
    digitalWrite(PIN_LASER, HIGH);
    laserPinState = true;
  } else {
    digitalWrite(PIN_LASER, LOW);
    laserPinState = false;
  }

  /*
   * Alert Priority Hierarchy:
   * 1. Laser interruption during active transmission: Continuous Alarm.
   *    (LDR HIGH / 1 = beam broken / no light)
   * 2. Vibration detected: Continuous Alarm.
   *    (Vibration HIGH / 1 = vibration)
   * 3. Object within <= 5 cm: Continuous Alarm.
   * 4. Object within 6 - 50 cm: Faster intermittent beeping.
   * 5. Object within 51 - 80 cm: Slow intermittent beeping.
   * 6. Distance unavailable while no higher alerts: Safe/Unavailable.
   * 7. All conditions normal: Safe (Buzzer OFF).
   */

  if (isTransmissionActive && ldrReading == 1) {
    // Priority 1: Laser interruption during active transmission
    currentAlert = ALERT_LASER_INTERRUPTION;
  } else if (vibrationReading == 1) {
    // Priority 2: Vibration event detected
    currentAlert = ALERT_VIBRATION;
  } else if (isDistanceValid && currentDistanceCm <= DISTANCE_CRITICAL_CM) {
    // Priority 3: Object critically close (<= 5cm)
    currentAlert = ALERT_CRITICAL_PROXIMITY;
  } else if (isDistanceValid && currentDistanceCm <= DISTANCE_DANGER_CM) {
    // Priority 4: Object within danger zone (6 - 50cm)
    currentAlert = ALERT_PROXIMITY_DANGER;
  } else if (isDistanceValid && currentDistanceCm <= DISTANCE_WARNING_CM) {
    // Priority 5: Object within warning zone (51 - 80cm)
    currentAlert = ALERT_PROXIMITY_WARNING;
  } else if (!isDistanceValid) {
    // Ultrasonic echo unavailable, no active alarm
    currentAlert = ALERT_DISTANCE_UNAVAILABLE;
  } else {
    // All parameters within safe limits
    currentAlert = ALERT_SAFE;
  }
}

// ----------------------------------------------------------------------------
// Non-Blocking Buzzer State Machine
// ----------------------------------------------------------------------------
void updateBuzzerState() {
  unsigned long now = millis();

  switch (currentAlert) {
    case ALERT_LASER_INTERRUPTION:
    case ALERT_VIBRATION:
    case ALERT_CRITICAL_PROXIMITY:
      // Continuous alarm
      buzzerPhysicalState = true;
      digitalWrite(PIN_BUZZER, HIGH);
      break;

    case ALERT_PROXIMITY_DANGER: {
      // Faster intermittent beeping: 100ms ON, 100ms OFF (period: 200ms)
      const unsigned long DANGER_CYCLE = 200UL;
      unsigned long phaseOffset = now % DANGER_CYCLE;
      if (phaseOffset < 100UL) {
        buzzerPhysicalState = true;
        digitalWrite(PIN_BUZZER, HIGH);
      } else {
        buzzerPhysicalState = false;
        digitalWrite(PIN_BUZZER, LOW);
      }
      break;
    }

    case ALERT_PROXIMITY_WARNING: {
      // Slow intermittent beeping: 250ms ON, 500ms OFF (period: 750ms)
      const unsigned long WARNING_CYCLE = 750UL;
      unsigned long phaseOffset = now % WARNING_CYCLE;
      if (phaseOffset < 250UL) {
        buzzerPhysicalState = true;
        digitalWrite(PIN_BUZZER, HIGH);
      } else {
        buzzerPhysicalState = false;
        digitalWrite(PIN_BUZZER, LOW);
      }
      break;
    }

    case ALERT_DISTANCE_UNAVAILABLE:
    case ALERT_SAFE:
    default:
      // Buzzer turned OFF
      buzzerPhysicalState = false;
      digitalWrite(PIN_BUZZER, LOW);
      break;
  }
}

// ----------------------------------------------------------------------------
// Newline-Delimited JSON Telemetry Transmission
// ----------------------------------------------------------------------------
void sendTelemetry() {
  // Map alert enum to protocol alert strings
  const char* alertStr = "SAFE";
  switch (currentAlert) {
    case ALERT_LASER_INTERRUPTION:    alertStr = "LASER_INTERRUPTION"; break;
    case ALERT_VIBRATION:             alertStr = "VIBRATION"; break;
    case ALERT_CRITICAL_PROXIMITY:    alertStr = "CRITICAL_PROXIMITY"; break;
    case ALERT_PROXIMITY_DANGER:      alertStr = "PROXIMITY_DANGER"; break;
    case ALERT_PROXIMITY_WARNING:     alertStr = "PROXIMITY_WARNING"; break;
    case ALERT_DISTANCE_UNAVAILABLE:  alertStr = "DISTANCE_UNAVAILABLE"; break;
    case ALERT_SAFE:                  alertStr = "SAFE"; break;
  }

  // Format JSON payload without heap allocations
  char jsonBuffer[256];
  if (isDistanceValid) {
    snprintf(jsonBuffer, sizeof(jsonBuffer),
      "{\"type\":\"sensor\",\"transmission\":%s,\"ldr\":%d,\"vibration\":%d,\"distance_cm\":%.1f,\"distance_valid\":true,\"laser\":\"%s\",\"buzzer\":\"%s\",\"alert\":\"%s\"}",
      isTransmissionActive ? "true" : "false",
      ldrReading,
      vibrationReading,
      currentDistanceCm,
      laserPinState ? "ON" : "OFF",
      buzzerPhysicalState ? "ON" : "OFF",
      alertStr
    );
  } else {
    snprintf(jsonBuffer, sizeof(jsonBuffer),
      "{\"type\":\"sensor\",\"transmission\":%s,\"ldr\":%d,\"vibration\":%d,\"distance_cm\":null,\"distance_valid\":false,\"laser\":\"%s\",\"buzzer\":\"%s\",\"alert\":\"%s\"}",
      isTransmissionActive ? "true" : "false",
      ldrReading,
      vibrationReading,
      laserPinState ? "ON" : "OFF",
      buzzerPhysicalState ? "ON" : "OFF",
      alertStr
    );
  }

  // Send single line terminated with newline
  Serial.println(jsonBuffer);
}

// ----------------------------------------------------------------------------
// Serial Command Processing
// ----------------------------------------------------------------------------
void handleSerialCommands() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();

    if (c == '\r') {
      continue; // Ignore carriage return
    }

    if (c == '\n') {
      if (serialCommandIndex > 0) {
        serialCommandBuffer[serialCommandIndex] = '\0';
        executeCommand(serialCommandBuffer);
        serialCommandIndex = 0;
      }
    } else {
      if (serialCommandIndex < SERIAL_BUF_SIZE - 1) {
        serialCommandBuffer[serialCommandIndex++] = c;
      } else {
        // Buffer overflow protection: reset buffer
        serialCommandIndex = 0;
      }
    }
  }
}

void executeCommand(const char* command) {
  if (strcmp(command, "START_TRANSMISSION") == 0) {
    isTransmissionActive = true;
    digitalWrite(PIN_LASER, HIGH);
    laserPinState = true;
    sendAck("START_TRANSMISSION", true, true);
  } else if (strcmp(command, "STOP_TRANSMISSION") == 0) {
    isTransmissionActive = false;
    digitalWrite(PIN_LASER, LOW);
    laserPinState = false;
    sendAck("STOP_TRANSMISSION", true, false);
  } else {
    // Unrecognized command
    sendAck(command, false, isTransmissionActive);
  }
}

void sendAck(const char* cmd, bool success, bool transmissionState) {
  char ackBuffer[160];
  snprintf(ackBuffer, sizeof(ackBuffer),
    "{\"type\":\"ack\",\"command\":\"%s\",\"success\":%s,\"transmission\":%s}",
    cmd,
    success ? "true" : "false",
    transmissionState ? "true" : "false"
  );
  Serial.println(ackBuffer);
}
